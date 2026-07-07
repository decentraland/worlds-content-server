import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'

function formatSecs(millis: number): string {
  return `${(millis / 1000).toFixed(2)} secs`
}

export async function garbageCollectionHandler(
  context: HandlerContextWithPath<'database' | 'logs' | 'pendingScenesManager' | 'storage', '/gc'>
): Promise<IHttpServerComponent.IResponse> {
  const { database, logs, pendingScenesManager, storage } = context.components
  const logger = logs.getLogger('garbage-collection')

  async function getAllActiveKeys() {
    const start = Date.now()
    logger.info('Getting all keys active in the database...')

    const activeKeys = new Set<string>()

    // Get all scenes from world_scenes table
    const scenesResult = await database.query<{
      entity_id: string
      entity: {
        content?: Array<{ hash: string }>
      }
    }>('SELECT entity_id, entity FROM world_scenes WHERE entity IS NOT NULL')
    scenesResult.rows.forEach((row) => {
      // Add entity file and deployment auth-chain
      activeKeys.add(row.entity_id)
      activeKeys.add(`${row.entity_id}.auth`)

      // Add all referenced content files
      if (row.entity.content) {
        for (const file of row.entity.content) {
          activeKeys.add(file.hash)
        }
      }
    })

    // Get all world thumbnail hashes and add them as active keys
    const thumbnailsResult = await database.query<{ thumbnail_hash: string }>(
      'SELECT thumbnail_hash FROM worlds WHERE thumbnail_hash IS NOT NULL'
    )
    thumbnailsResult.rows.forEach((row) => {
      activeKeys.add(row.thumbnail_hash)
    })

    // Non-expired partial (pending) deployments: their entity id, auth-chain key, and content hashes
    // are still referenced even though no world_scenes row exists yet.
    for (const key of await pendingScenesManager.getActivePendingKeys()) {
      activeKeys.add(key)
    }

    logger.info(`Done in ${formatSecs(Date.now() - start)}. Database contains ${activeKeys.size} active keys.`)

    return activeKeys
  }

  logger.info('Starting garbage collection...')

  const activeKeys = await getAllActiveKeys()

  logger.info('Getting keys from storage that are not currently active...')
  const start = Date.now()
  let totalRemovedKeys = 0
  const batch = new Set<string>()

  // Re-check right before deleting: the activeKeys snapshot was taken once, but partial uploads
  // stage content across a long window and one can START mid-sweep (its pending row is written just
  // before its content). Subtracting the CURRENT pending keys from each batch keeps a freshly-staged
  // upload's content from being reclaimed while the sweep is in flight. pending_scenes is tiny, so
  // this re-query per batch is cheap.
  const deleteBatch = async (keys: Set<string>): Promise<void> => {
    const pendingNow = await pendingScenesManager.getActivePendingKeys()
    const toDelete = [...keys].filter((key) => !pendingNow.has(key))
    if (toDelete.length === 0) {
      return
    }
    logger.info(`Deleting a batch of ${toDelete.length} keys from storage...`)
    await storage.delete(toDelete)
    totalRemovedKeys += toDelete.length
  }

  for await (const key of storage.allFileIds()) {
    if (!activeKeys.has(key)) {
      batch.add(key)
    }

    if (batch.size === 1000) {
      await deleteBatch(batch)
      batch.clear()
    }
  }

  if (batch.size > 0) {
    await deleteBatch(batch)
  }
  logger.info(
    `Done in ${formatSecs(Date.now() - start)}. Deleted ${totalRemovedKeys} keys that are not active in the storage.`
  )

  logger.info('Garbage collection finished.')

  return {
    status: 200,
    body: {
      message: `Garbage collection removed ${totalRemovedKeys} unused keys.`
    }
  }
}
