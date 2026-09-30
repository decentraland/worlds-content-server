import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { getReferencedContentKeys } from '../../adapters/content-references'
import { ContentLockTimeoutError } from '../../adapters/content-locks/errors'

type GarbageCollectionContext = HandlerContextWithPath<
  'database' | 'logs' | 'metrics' | 'pendingScenesManager' | 'storage' | 'contentLocks',
  '/gc'
>

/** Runs garbage collection, recording its outcome, duration and last success. */
export async function garbageCollectionHandler(
  context: GarbageCollectionContext
): Promise<IHttpServerComponent.IResponse> {
  const { metrics } = context.components
  const { end } = metrics.startTimer('garbage_collection_duration_seconds')
  let outcome: 'success' | 'deferred' | 'error' = 'error'
  try {
    const response = await collectGarbage(context)
    outcome = 'success'
    metrics.observe('garbage_collection_last_success_timestamp_seconds', {}, Date.now() / 1000)
    return response
  } catch (error) {
    if (error instanceof ContentLockTimeoutError) outcome = 'deferred'
    throw error
  } finally {
    end()
    metrics.increment('garbage_collection_runs', { outcome })
  }
}

/** Deletes unreferenced content in bounded batches, excluding uploads through each check/delete pair. */
async function collectGarbage(context: GarbageCollectionContext): Promise<IHttpServerComponent.IResponse> {
  const { database, logs, metrics, pendingScenesManager, storage, contentLocks } = context.components
  const logger = logs.getLogger('garbage-collection')
  let removed = 0
  let batch: string[] = []
  async function flush(): Promise<void> {
    const keys = batch
    batch = []
    await contentLocks.withWrite(async () => {
      const referenced = await getReferencedContentKeys(
        database,
        new Date(Date.now() - pendingScenesManager.ttlMs),
        keys
      )
      const orphaned = keys.filter((key) => !referenced.has(key))
      if (orphaned.length) {
        await storage.delete(orphaned)
        removed += orphaned.length
        metrics.increment('garbage_collection_removed_keys', {}, orphaned.length)
      }
    })
  }
  for await (const key of storage.allFileIds()) {
    batch.push(key)
    if (batch.length === 1000) await flush()
  }
  if (batch.length) await flush()
  // Release expired accounting only after its physical objects are reclaimed or referenced elsewhere.
  await pendingScenesManager.deleteExpired()
  logger.info('Garbage collection finished', { removed })
  return { status: 200, body: { message: `Garbage collection removed ${removed} unused keys.` } }
}
