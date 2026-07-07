import { Entity } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/http-commons'
import {
  AppComponents,
  DeploymentFile,
  IPartialDeploymentsComponent,
  StageDeploymentInput,
  StageDeploymentResult
} from '../../types'

// How many content files to store to storage at once. They are independent content-addressed objects,
// so storing them concurrently (rather than one awaited PUT at a time) keeps a large batch fast.
const STORE_CONCURRENCY = 10

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

export function createPartialDeploymentsComponent(
  components: Pick<
    AppComponents,
    | 'coordinates'
    | 'entityDeployer'
    | 'limitsManager'
    | 'logs'
    | 'pendingScenesManager'
    | 'storage'
    | 'validator'
    | 'worldsManager'
  >
): IPartialDeploymentsComponent {
  const { coordinates, entityDeployer, limitsManager, logs, pendingScenesManager, storage, validator, worldsManager } =
    components
  const logger = logs.getLogger('partial-deployments')

  /**
   * Rejects the deployment if a strictly-newer scene already occupies any of these parcels. "Newer"
   * follows the deployment ordering used across Decentraland: greater entity timestamp, breaking ties
   * by greater entity id. Without this a stale pending upload (its TTL anchored on when it started,
   * up to 24h ago) could finalize and silently overwrite a newer scene deployed while it was in flight.
   */
  async function assertNoNewerDeployment(worldName: string, entity: Entity, parcels: string[]): Promise<void> {
    const { scenes } = await worldsManager.getWorldScenes({ worldName, coordinates: parcels })
    const newer = scenes.find(
      (scene) =>
        scene.entityId !== entity.id &&
        (scene.entity.timestamp > entity.timestamp ||
          (scene.entity.timestamp === entity.timestamp && scene.entityId > entity.id))
    )
    if (newer) {
      throw new InvalidRequestError(
        `Deployment failed: a newer scene (${newer.entityId}) is already deployed on one or more of these parcels.`
      )
    }
  }

  async function storeFiles(
    files: Map<string, DeploymentFile>,
    alreadyStored: (hash: string) => boolean
  ): Promise<void> {
    const toStore = Array.from(files).filter(([hash]) => !alreadyStored(hash))
    for (let i = 0; i < toStore.length; i += STORE_CONCURRENCY) {
      await Promise.all(
        toStore.slice(i, i + STORE_CONCURRENCY).map(([hash, file]) => storage.storeStream(hash, file.getStream()))
      )
    }
  }

  async function stage(input: StageDeploymentInput): Promise<StageDeploymentResult> {
    const { baseUrl, entity, entityRaw, authChain, files } = input
    const contentHashes = Array.from(new Set((entity.content ?? []).map((c) => c.hash)))

    const pending = await pendingScenesManager.getByEntityId(entity.id)

    // Single storage metadata lookup over the referenced content: presence is `info !== undefined`
    // and size is `info.size`, so this subsumes a separate existence probe.
    const storedInfo = await storage.fileInfoMultiple(contentHashes)
    const contentHashesInStorage = new Map(contentHashes.map((hash) => [hash, storedInfo.get(hash) !== undefined]))

    // Content-independent validations (structure, signature, scene rules, permission), anchoring the
    // deployment-TTL check on when the upload started when a pending row already exists.
    const stagingValidation = await validator.validateStaging({
      entity,
      files,
      authChain,
      contentHashesInStorage,
      pendingCreatedAt: pending?.createdAt
    })
    if (!stagingValidation.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${stagingValidation.errors.join(', ')}`)
    }

    const worldName = entity.metadata.worldConfiguration.name.toLowerCase()
    const parcels = Array.from(new Set(coordinates.canonicalizeParcels(entity.pointers)))
    const deployer = authChain[0].payload

    // Reject early (before touching any pending state) if a newer scene already holds these parcels.
    await assertNoNewerDeployment(worldName, entity, parcels)

    // Cumulative size budget: uploaded bytes for this batch + stored sizes for earlier batches. Checked
    // BEFORE the upsert below, because upsert's overlap-replace destroys any other in-flight upload of
    // this world — an over-budget request must not take another deployer's pending upload down with it.
    let totalSize = 0
    for (const hash of contentHashes) {
      const uploaded = files.get(hash)
      totalSize += uploaded ? uploaded.size : (storedInfo.get(hash)?.size ?? 0)
    }
    const maxSize = await limitsManager.getMaxAllowedSizeInBytesFor(worldName, parcels)
    if (BigInt(totalSize) > maxSize) {
      throw new InvalidRequestError(
        `Deployment failed: The deployment is too big. The maximum total size allowed is ${maxSize} bytes for scenes but you tried to upload ${totalSize}.`
      )
    }

    // Record/refresh the pending scene BEFORE storing files, so staged content is protected from the
    // garbage collector as soon as it lands. Replaces any overlapping pending upload of this world.
    const upserted = await pendingScenesManager.upsert({ entityId: entity.id, worldName, parcels, entity, deployer })

    // Store this batch's files (content-addressed, so concurrent identical writes are idempotent),
    // skipping content already stored. The entity JSON (keyed by entity.id, not in contentHashes) is
    // small and always (re)stored, which covers the first request.
    await storeFiles(files, (hash) => hash !== entity.id && storedInfo.get(hash) !== undefined)

    // Completeness must be a fresh read, not derived from the start-of-request snapshot: a concurrent
    // partial request for the same entity may have stored the remaining files while this one ran, and
    // whichever request observes the full set is the one that finalizes.
    const present = await storage.existMultiple(contentHashes)
    const missing = contentHashes.filter((hash) => !present.get(hash))
    if (missing.length > 0) {
      return { complete: false, missing }
    }

    // Everything is present — re-check for a newer deployment (one may have landed while this upload was
    // in flight) and run the full validation before deploying in this same request.
    await assertNoNewerDeployment(worldName, entity, parcels)

    const fullValidation = await validator.validate({
      entity,
      files,
      authChain,
      contentHashesInStorage: present,
      pendingCreatedAt: upserted.createdAt
    })
    if (!fullValidation.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${fullValidation.errors.join(', ')}`)
    }

    try {
      const result = await entityDeployer.deployEntity(baseUrl, entity, present, files, entityRaw, authChain)
      await pendingScenesManager.deleteByEntityId(entity.id)
      return { complete: true, result }
    } catch (error) {
      // Concurrent finalize: another request completing the same upload won the world_scenes PK insert.
      // If the scene is now deployed, treat this request as an idempotent success.
      if (isUniqueViolation(error)) {
        const existing = await worldsManager.getWorldScenes({ worldName, entityId: entity.id }, { limit: 1 })
        if (existing.scenes.length > 0) {
          await pendingScenesManager.deleteByEntityId(entity.id)
          logger.info(`Partial deployment finalized concurrently; returning idempotent success`, {
            entityId: entity.id,
            worldName
          })
          return { complete: true, result: { message: `Your scene was deployed to World "${worldName}".` } }
        }
      }
      throw error
    }
  }

  return { stage }
}
