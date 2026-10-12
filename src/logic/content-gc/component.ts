import { AppComponents } from '../../types'
import { ContentLockTimeoutError } from '../../adapters/content-locks/errors'
import { ExpiredUploadCursor } from '../../adapters/pending-scenes-repository/types'
import { errorMessage } from '../utils'
import { ExpiredUploadsCleanup, GarbageCollection, IContentGcComponent } from './types'

/** Keys checked and deleted per exclusive-lock hold. */
export const GC_BATCH_SIZE = 1000
/** Expired uploads fetched per cleanup query. */
export const CLEANUP_PAGE_SIZE = 100

/**
 * Creates the deletion of unreferenced content: the storage-wide sweep and expired-upload reclamation.
 * Every check/delete pair runs under the exclusive content lock, so publication can't race it.
 * @param components Persistence, storage, lock, staging accounting and telemetry dependencies.
 * @returns Content garbage collection operations.
 */
export async function createContentGcComponent(
  components: Pick<
    AppComponents,
    | 'logs'
    | 'metrics'
    | 'storage'
    | 'contentLocks'
    | 'partialUploadAdmission'
    | 'pendingScenesRepository'
    | 'uploadLimits'
  >
): Promise<IContentGcComponent> {
  const { logs, metrics, storage, contentLocks, partialUploadAdmission, pendingScenesRepository, uploadLimits } =
    components
  const gcLogger = logs.getLogger('garbage-collection')
  // Keeps the cleanup's original logger name.
  const cleanupLogger = logs.getLogger('pending-scenes-manager')
  const ttlMs = uploadLimits.pendingDeploymentTtlMs

  async function deleteUnreferenced(keys: string[]): Promise<number> {
    let removed = 0
    for (let offset = 0; offset < keys.length; offset += GC_BATCH_SIZE) {
      const batch = keys.slice(offset, offset + GC_BATCH_SIZE)
      removed += await contentLocks.withWrite(async () => {
        const referenced = await pendingScenesRepository.getReferencedContentKeys(new Date(Date.now() - ttlMs), batch)
        const orphaned = batch.filter((key) => !referenced.has(key))
        if (orphaned.length) await storage.delete(orphaned)
        return orphaned.length
      })
    }
    return removed
  }

  async function collectGarbage(): Promise<GarbageCollection> {
    let removed = 0
    let batch: string[] = []
    async function flush(): Promise<void> {
      const keys = batch
      batch = []
      const orphaned = await deleteUnreferenced(keys)
      if (orphaned) {
        removed += orphaned
        metrics.increment('garbage_collection_removed_keys', {}, orphaned)
      }
    }
    for await (const key of storage.allFileIds()) {
      batch.push(key)
      if (batch.length === GC_BATCH_SIZE) await flush()
    }
    if (batch.length) await flush()
    // Release expired accounting only after its physical objects are reclaimed or referenced elsewhere.
    // Its deferral or failures don't undo the sweep: reported here and in its own metrics, retried by its job.
    const expiredUploads = await deleteExpiredUploads()
    gcLogger.info('Garbage collection finished', { removed, expiredUploads: expiredUploads.outcome })
    return { removed, expiredUploads }
  }

  // The scheduled job and POST /gc both run cleanup; runs are serialized so they never overlap.
  let cleanupQueue: Promise<unknown> = Promise.resolve()

  function deleteExpiredUploads(): Promise<ExpiredUploadsCleanup> {
    const run = cleanupQueue.then(runCleanup)
    cleanupQueue = run.catch(() => undefined)
    return run
  }

  async function runCleanup(): Promise<ExpiredUploadsCleanup> {
    const { end } = metrics.startTimer('partial_upload_cleanup_duration_seconds')
    let outcome: ExpiredUploadsCleanup['outcome'] = 'error'
    try {
      const sweep = await sweepExpired()
      // Runs whatever the sweep did, so receipts, rate windows and gauges never go stale.
      await partialUploadAdmission.pruneAndReport()
      outcome = sweep.outcome
      if (outcome === 'success') {
        metrics.observe('partial_upload_cleanup_last_success_timestamp_seconds', {}, Date.now() / 1000)
      }
      cleanupLogger.info('Cleaned expired uploads', sweep)
      return sweep
    } finally {
      end()
      metrics.increment('partial_upload_cleanup_runs', { outcome })
      // Any finished run counts: the next one is scheduled an interval later regardless of its outcome.
      partialUploadAdmission.recordCleanupFinished()
    }
  }

  async function sweepExpired(): Promise<ExpiredUploadsCleanup> {
    const cutoff = new Date(Date.now() - ttlMs)
    let removed = 0
    let failed = 0
    let after: ExpiredUploadCursor | undefined
    try {
      // Pages until a short one: every upload expired before the cutoff is visited once.
      for (;;) {
        const page = await pendingScenesRepository.listExpired(cutoff, after, CLEANUP_PAGE_SIZE)
        for (const upload of page) {
          after = upload
          const { entityId } = upload
          try {
            await reclaimUpload(entityId, cutoff)
            removed++
            metrics.increment('partial_upload_expired_uploads')
          } catch (error) {
            // Uploads keep the lock busy: retry next run rather than wait.
            if (error instanceof ContentLockTimeoutError) {
              cleanupLogger.warn('Deferred expired upload cleanup: the content lock is busy', {
                entityId,
                removed,
                failed
              })
              return { outcome: failed ? 'error' : 'deferred', removed, failed }
            }
            failed++
            metrics.increment('partial_upload_cleanup_failed_uploads')
            cleanupLogger.error('Failed to reclaim expired upload', { entityId, error: errorMessage(error) })
          }
        }
        if (page.length < CLEANUP_PAGE_SIZE) break
      }
    } catch (error) {
      cleanupLogger.error('Failed to list expired uploads', { error: errorMessage(error) })
      return { outcome: 'error', removed, failed }
    }
    return { outcome: failed ? 'error' : 'success', removed, failed }
  }

  /**
   * Deletes an expired upload's orphaned staged objects, then releases its accounting.
   * @throws ContentLockTimeoutError when uploads keep the content lock busy.
   */
  async function reclaimUpload(entityId: string, cutoff: Date): Promise<void> {
    await deleteUnreferenced(await pendingScenesRepository.getUploadKeys(entityId))
    await pendingScenesRepository.releaseExpired(entityId, cutoff)
  }

  return { deleteUnreferenced, collectGarbage, deleteExpiredUploads }
}
