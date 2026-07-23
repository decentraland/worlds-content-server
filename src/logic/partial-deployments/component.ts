import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents, DeploymentFile } from '../../types'
import { mapWithConcurrency } from '../concurrency'
import { buildSceneDeploymentMessage } from '../utils'
import { calculateDeploymentSizeFromFileInfos } from '../validations/scene'
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

  async function deletePendingRowBestEffort(entityId: string, worldName: string): Promise<void> {
    try {
      await pendingScenesManager.deleteByEntityId(entityId)
    } catch (error: any) {
      logger.warn('Failed to delete pending scene after a successful deploy; it will expire via TTL', {
        entityId,
        worldName,
        error: error?.message ?? `${error}`
      })
    }
  }

  async function storeFiles(files: Map<string, DeploymentFile>, signal?: AbortSignal): Promise<void> {
    // Store every file the client sent this batch through a bounded worker pool. We do NOT skip files a
    // pre-request snapshot said were already stored: that snapshot predates the pending row (and its GC
    // protection), so a file present then could be swept before we store, and skipping it would discard
    // bytes uploaded in this very batch. Storage is content-addressed (re-store is an idempotent no-op)
    // and the client already omits files reported by /available-content, so this rarely re-sends
    // present content anyway. mapWithConcurrency (not a bare Promise.all) so a store failure or a
    // cancellation lets already-started uploads settle before the error is rethrown — the streams read
    // request-scoped temp files that the multipart wrapper removes as soon as the request unwinds.
    // Partially-stored content is harmless: the pending row protects it and a resume re-sends the rest.
    await mapWithConcurrency(
      Array.from(files),
      STORE_CONCURRENCY,
      ([hash, file]) => storage.storeStream(hash, file.getStream(signal)),
      { signal }
    )
  }

  async function stage(input: StageDeploymentInput): Promise<StageDeploymentResult> {
    const { baseUrl, entity, entityRaw, authChain, files, signal, deadlineAt } = input
    // Short-circuit an already-cancelled request before any I/O. Later stages re-check (staging
    // validation, storeFiles, before the finalize validation), but the guarantee that a cancelled
    // request writes no state should not rest on the validator honoring the signal.
    signal?.throwIfAborted()
    const contentHashes = Array.from(new Set((entity.content ?? []).map((c) => c.hash)))

    // These two lookups are independent (the pending row vs. the content metadata), so run them
    // concurrently — one is a DB round-trip, the other a batched storage HEAD. The single metadata
    // lookup also subsumes a separate existence probe: presence is `info !== undefined`, size is
    // `info.size`.
    const [pending, storedInfo] = await Promise.all([
      pendingScenesManager.getByEntityId(entity.id),
      storage.fileInfoMultiple(contentHashes)
    ])
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
        pendingCreatedAt: pending?.createdAt,
        signal
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
    if (!pending && (await worldsManager.hasNewerDeployedScene(worldName, entity))) {
      throw new InvalidRequestError(
        'Deployment failed: a newer scene is already deployed on one or more of these parcels.'
      )
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
    await storeFiles(files, signal)

    // Completeness must be a fresh read, not derived from the start-of-request snapshot: a concurrent
    // partial request for the same entity may have stored the remaining files while this one ran, and
    // whichever request observes the full set is the one that finalizes. Fetched as metadata (not bare
    // existence) because, on the finalize path, these fresh sizes feed the full validation's size check
    // and the size persisted with the scene — the start-of-request `storedInfo` snapshot must NOT be
    // used for that: files stored by sibling requests after it was taken would count as 0 and skew
    // quota accounting.
    let presentInfos: Awaited<ReturnType<typeof storage.fileInfoMultiple>>
    try {
      presentInfos = await storage.fileInfoMultiple(contentHashes)
    } catch (error: any) {
      // Folder-based storage's fileInfo has an exist->stat window that rejects (ENOENT) when a file is
      // reclaimed mid-check — the very GC race this gate exists to absorb (S3's fileInfo returns
      // undefined instead). One immediate retry resolves that race deterministically: the reclaimed
      // file now reports undefined and lands in `missing` (a retriable 202). If metadata STILL cannot
      // be read, it is a real storage failure — let it surface (no progress is possible anyway) rather
      // than answer with a self-contradictory "incomplete but nothing missing".
      logger.warn('Completeness metadata read failed; retrying once', {
        entityId: entity.id,
        worldName,
        error: error?.message ?? `${error}`
      })
      presentInfos = await storage.fileInfoMultiple(contentHashes)
    }
    const missing = contentHashes.filter((hash) => presentInfos.get(hash) === undefined)
    if (missing.length > 0) {
      return { complete: false, missing }
    }
    const present = new Map(contentHashes.map((hash) => [hash, true]))

    // Everything is present — run the full validation + deploy in this same request. Concurrent
    // completing requests (the client's parallel worker pool, retries) may race here; the world_scenes
    // primary key serializes them, and the loser's unique-violation is mapped to an idempotent success
    // in the catch below. The duplicated validation in that rare race is accepted — a coordination
    // mechanism to avoid it costs more in failure modes than the validation it saves.
    try {
      // Run the full validation before deploying, in this same request. `contentFileInfos` hands the
      // size check the fresh metadata fetched above: without it the check would fall back to one
      // sequential storage read per non-batch file, and a file reclaimed by GC mid-validation would
      // surface as a terminal 400 instead of the retriable incomplete the re-check below produces.
      signal?.throwIfAborted()
      const fullValidation = await validator.validate({
        entity,
        files,
        authChain,
        contentHashesInStorage: present,
        contentFileInfos: presentInfos,
        pendingCreatedAt: pendingRow.createdAt,
        signal
      })
      if (!fullValidation.ok()) {
        throw new InvalidRequestError(`Deployment failed: ${fullValidation.errors.join(', ')}`)
      }

      // No pre-write newer-deployment re-check here: deployScene enforces deployment ordering atomically
      // under a per-world lock (rejecting an older deploy that would overwrite a newer scene), so a
      // separate check would be both racy and redundant. The early hasNewerDeployedScene check above is
      // kept only as a fast-fail for new uploads.

      // Re-verify content presence immediately before the deploy commits. The completeness check above
      // ran before the (slow) full validation, and a garbage-collection sweep could have reclaimed a
      // reused, already-stored file in that window (the pending row protects content, but a GC batch
      // whose snapshot predates this row would not see it). Committing a scene that references deleted
      // content would corrupt it, so if anything is missing now, return incomplete (the pending row
      // stays, so the client re-uploads) — shrinking the DB-row-vs-object-storage window to check-to-commit.
      const stillPresent = await storage.existMultiple(contentHashes)
      const nowMissing = contentHashes.filter((hash) => !stillPresent.get(hash))
      if (nowMissing.length > 0) {
        return { complete: false, missing: nowMissing }
      }

      // Persist the size computed from the fresh completeness metadata, NOT the request-local budget
      // estimate (`totalSize`): its start-of-request snapshot misses files stored by sibling requests
      // in the meantime, which would be counted as 0 and undercount world_scenes.size (skewing wallet
      // quota accounting). Sizes are immutable per content hash, so the completeness-time metadata is
      // exact. Cancellation stops applying once the deploy transaction reaches its commit boundary.
      const deploymentSize = calculateDeploymentSizeFromFileInfos(entity, files, presentInfos)
      const result = await entityDeployer.deployEntity(
        baseUrl,
        entity,
        stillPresent,
        files,
        entityRaw,
        authChain,
        deploymentSize,
        signal,
        deadlineAt
      )
      // The deploy has committed: from here on the response must be success. A failed pending-row delete
      // only leaves a row the eviction job will expire, so it must not surface as an error.
      await deletePendingRowBestEffort(entity.id, worldName)
      return { complete: true, result }
    } catch (error) {
      // Concurrent finalize: another completing request won the world_scenes PK insert. The scene is
      // deployed, so treat this request as an idempotent success.
      if (isUniqueViolation(error)) {
        // Best-effort verification: if it fails, propagate the ORIGINAL collision rather than masking
        // it with the verification hiccup.
        const existing = await worldsManager
          .getWorldScenes({ worldName, entityId: entity.id }, { limit: 1 })
          .catch(() => ({ scenes: [], total: 0 }))
        if (existing.scenes.length > 0) {
          await deletePendingRowBestEffort(entity.id, worldName)
          logger.info(`Partial deployment finalized concurrently; returning idempotent success`, {
            entityId: entity.id,
            worldName
          })
          return {
            complete: true,
            result: {
              message: buildSceneDeploymentMessage(baseUrl, entity.metadata.worldConfiguration.name, parcels)
            }
          }
        }
      }
      // Finalize failed without deploying: the pending row stays, so a later completing request retries.
      // A terminal validation error still propagates as a 4xx (the client won't retry; the row expires
      // via TTL).
      throw error
    }
  }

  return { stage }
}
