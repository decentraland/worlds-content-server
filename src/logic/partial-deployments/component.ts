import { Entity } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents, DeploymentFile } from '../../types'
import { IPartialDeploymentsComponent, StageDeploymentInput, StageDeploymentResult } from './types'

// How many content files to store to storage at once. They are independent content-addressed objects,
// so storing them concurrently (rather than one awaited PUT at a time) keeps a large batch fast.
const STORE_CONCURRENCY = 10

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

// Default cap on the number of concurrent non-expired pending uploads a single deployer may have in
// flight. Bounds the storage a deployer can pin at once (each upload is already bounded by the
// per-world size limit) without throttling legitimate parallel deploys. Override via config.
const DEFAULT_MAX_PENDING_PER_DEPLOYER = 10

export async function createPartialDeploymentsComponent(
  components: Pick<
    AppComponents,
    | 'config'
    | 'coordinates'
    | 'entityDeployer'
    | 'limitsManager'
    | 'logs'
    | 'pendingScenesManager'
    | 'storage'
    | 'validator'
    | 'worldsManager'
  >
): Promise<IPartialDeploymentsComponent> {
  const {
    config,
    coordinates,
    entityDeployer,
    limitsManager,
    logs,
    pendingScenesManager,
    storage,
    validator,
    worldsManager
  } = components
  const logger = logs.getLogger('partial-deployments')
  const maxPendingPerDeployer =
    (await config.getNumber('MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER')) ?? DEFAULT_MAX_PENDING_PER_DEPLOYER

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

  async function storeFiles(files: Map<string, DeploymentFile>): Promise<void> {
    // Store every file the client sent this batch, in bounded-parallel batches. We do NOT skip files a
    // pre-request snapshot said were already stored: that snapshot predates the pending row (and its GC
    // protection), so a file present then could be swept before we store, and skipping it would discard
    // bytes uploaded in this very batch. Storage is content-addressed (re-store is an idempotent no-op)
    // and the client already omits files reported by /available-content, so this rarely re-sends
    // present content anyway.
    const toStore = Array.from(files)
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
    //
    // Resume batches skip the slow external permission check, but only when the signer is the deployer
    // who created the pending record: that creation required passing the check, every uploaded byte is
    // hash-verified against the staged manifest, and finalize re-runs the full validation (including
    // permission) before going live. Any other signer goes through the full staging validation, so a
    // third party can't ride an existing upload's fast path.
    const isResumeBySameDeployer = !!pending && pending.deployer === authChain[0].payload.toLowerCase()
    const stagingValidation = await validator.validateStaging(
      {
        entity,
        files,
        authChain,
        contentHashesInStorage,
        pendingCreatedAt: pending?.createdAt
      },
      { skipPermissionCheck: isResumeBySameDeployer }
    )
    if (!stagingValidation.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${stagingValidation.errors.join(', ')}`)
    }

    const worldName = entity.metadata.worldConfiguration.name.toLowerCase()
    const parcels = Array.from(new Set(coordinates.canonicalizeParcels(entity.pointers)))
    const deployer = authChain[0].payload

    // Reject a NEW upload early (before it replaces any pending state) if a newer scene already holds
    // these parcels. Fast-fail only: deployScene enforces ordering atomically at finalize. Resume
    // batches skip it (they never deploy by themselves) to avoid a per-batch world_scenes query.
    // (The per-deployer concurrent-pending cap is enforced atomically inside upsert below.)
    if (!pending) {
      await assertNoNewerDeployment(worldName, entity, parcels)
    }

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

    // Record/refresh the pending scene on EVERY batch, always BEFORE storing files: it is what protects
    // the staged content from the garbage collector, and re-asserting it per batch resurrects the row
    // if a competing overlapping upload replaced it between requests — otherwise this batch's files
    // would be written with no GC protection for the remainder of the upload. (On conflict the upsert
    // preserves created_at, so the TTL anchor stays stable across resumes.)
    const pendingRow = await pendingScenesManager.upsert(
      { entityId: entity.id, worldName, parcels, entity, deployer },
      { maxPendingPerDeployer }
    )

    // Store this batch's files (content-addressed, so concurrent identical writes are idempotent).
    await storeFiles(files)

    // Completeness must be a fresh read, not derived from the start-of-request snapshot: a concurrent
    // partial request for the same entity may have stored the remaining files while this one ran, and
    // whichever request observes the full set is the one that finalizes.
    const present = await storage.existMultiple(contentHashes)
    const missing = contentHashes.filter((hash) => !present.get(hash))
    if (missing.length > 0) {
      return { complete: false, missing }
    }

    // Everything is present — claim the finalization lease so only ONE request runs the expensive
    // validation + deploy for this completed upload (the client's parallel worker pool and retries mean
    // several completing requests can arrive at once).
    const gotLease = await pendingScenesManager.acquireFinalizationLease(entity.id)
    if (!gotLease) {
      // Another request is finalizing (or already did). If the scene is live now, report the idempotent
      // success; otherwise report not-yet-complete so the client backs off and retries — it converges
      // once the winner finishes (or its lease expires and this request can take over).
      const existing = await worldsManager.getWorldScenes({ worldName, entityId: entity.id }, { limit: 1 })
      if (existing.scenes.length > 0) {
        await pendingScenesManager.deleteByEntityId(entity.id).catch(() => undefined)
        return { complete: true, result: { message: `Your scene was deployed to World "${worldName}".` } }
      }
      return { complete: false, missing: [] }
    }

    try {
      // Run the full validation before deploying, in this same request.
      const fullValidation = await validator.validate({
        entity,
        files,
        authChain,
        contentHashesInStorage: present,
        pendingCreatedAt: pendingRow.createdAt
      })
      if (!fullValidation.ok()) {
        throw new InvalidRequestError(`Deployment failed: ${fullValidation.errors.join(', ')}`)
      }

      // No pre-write newer-deployment re-check here: deployScene enforces deployment ordering atomically
      // under a per-world lock (rejecting an older deploy that would overwrite a newer scene), so a
      // separate check would be both racy and redundant. The early assertNoNewerDeployment above is kept
      // only as a fast-fail for new uploads.

      // Re-verify content presence immediately before the deploy commits. The completeness check above
      // ran before the (slow) full validation, and a garbage-collection sweep could have reclaimed a
      // reused, already-stored file in that window (the pending row protects content, but a GC batch
      // whose snapshot predates this row would not see it). Committing a scene that references deleted
      // content would corrupt it, so if anything is missing now, release the lease and return incomplete
      // so the client re-uploads — shrinking the DB-row-vs-object-storage window to check-to-commit.
      const stillPresent = await storage.existMultiple(contentHashes)
      const nowMissing = contentHashes.filter((hash) => !stillPresent.get(hash))
      if (nowMissing.length > 0) {
        await pendingScenesManager.releaseFinalizationLease(entity.id)
        return { complete: false, missing: nowMissing }
      }

      const result = await entityDeployer.deployEntity(baseUrl, entity, stillPresent, files, entityRaw, authChain)
      await pendingScenesManager.deleteByEntityId(entity.id)
      return { complete: true, result }
    } catch (error) {
      // Concurrent finalize: another request won the world_scenes PK insert (e.g. a stale lease was taken
      // over by two requests). If the scene is now deployed, treat this request as an idempotent success.
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
      // Finalize failed without deploying: release the lease so a later request can retry. A terminal
      // validation error still propagates as a 4xx (the client won't retry; the row expires via TTL).
      await pendingScenesManager.releaseFinalizationLease(entity.id).catch(() => undefined)
      throw error
    }
  }

  return { stage }
}
