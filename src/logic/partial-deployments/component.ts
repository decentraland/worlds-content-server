import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents, IPartialDeploymentsComponent, StageDeploymentInput, StageDeploymentResult } from '../../types'

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

  async function stage(input: StageDeploymentInput): Promise<StageDeploymentResult> {
    const { baseUrl, entity, entityRaw, authChain, files } = input
    const contentHashes = Array.from(new Set((entity.content ?? []).map((c) => c.hash)))

    const pending = await pendingScenesManager.getByEntityId(entity.id)
    const contentHashesInStorage = await storage.existMultiple(contentHashes)

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

    // Record/refresh the pending scene BEFORE storing files, so staged content is protected from the
    // garbage collector as soon as it lands. Replaces any overlapping pending upload of this world.
    const upserted = await pendingScenesManager.upsert({ entityId: entity.id, worldName, parcels, entity, deployer })

    // Cumulative size budget: uploaded bytes for this batch + stored sizes for earlier batches. Checked
    // before storing this batch so an over-budget upload is never persisted (its row is dropped, and
    // any earlier staged content becomes reclaimable by GC once the row is gone).
    const storedInfo = await storage.fileInfoMultiple(contentHashes)
    let totalSize = 0
    for (const hash of contentHashes) {
      const uploaded = files.get(hash)
      totalSize += uploaded ? uploaded.size : (storedInfo.get(hash)?.size ?? 0)
    }
    const maxSize = await limitsManager.getMaxAllowedSizeInBytesFor(worldName, parcels)
    if (BigInt(totalSize) > maxSize) {
      await pendingScenesManager.deleteByEntityId(entity.id)
      throw new InvalidRequestError(
        `Deployment failed: The deployment is too big. The maximum total size allowed is ${maxSize} bytes for scenes but you tried to upload ${totalSize}.`
      )
    }

    // Store this batch's files (content-addressed, so concurrent identical writes are idempotent),
    // skipping anything already stored. This also stores the entity JSON on the first request.
    const uploadedKeys = Array.from(files.keys())
    const alreadyStored = await storage.existMultiple(uploadedKeys)
    for (const [hash, file] of files) {
      if (!alreadyStored.get(hash)) {
        await storage.storeStream(hash, file.getStream())
      }
    }

    // Completeness: if any referenced content is still missing, keep waiting for more requests.
    const present = await storage.existMultiple(contentHashes)
    const missing = contentHashes.filter((hash) => !present.get(hash))
    if (missing.length > 0) {
      return { complete: false, missing }
    }

    // Everything is present — run the full validation and deploy in this same request.
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
