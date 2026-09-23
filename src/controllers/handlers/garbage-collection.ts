import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { getReferencedContentKeys } from '../../adapters/content-references'

/** Deletes unreferenced content in bounded batches, excluding uploads through each check/delete pair. */
export async function garbageCollectionHandler(
  context: HandlerContextWithPath<'database' | 'logs' | 'pendingScenesManager' | 'storage' | 'contentLocks', '/gc'>
): Promise<IHttpServerComponent.IResponse> {
  const { database, logs, pendingScenesManager, storage, contentLocks } = context.components
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
