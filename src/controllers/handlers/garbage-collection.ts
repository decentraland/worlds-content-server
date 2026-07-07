import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import SQL from 'sql-template-strings'

function formatSecs(millis: number): string {
  return `${(millis / 1000).toFixed(2)} secs`
}

const DEFAULT_PENDING_DEPLOYMENT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export async function garbageCollectionHandler(
  context: HandlerContextWithPath<'config' | 'database' | 'logs' | 'storage', '/gc'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, database, logs, storage } = context.components
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
    // are still referenced even though no world_scenes row exists yet. Cutoff-filtered so staged content
    // becomes reclaimable exactly when the pending upload expires, even if the eviction job lags.
    const pendingTtlMs = (await config.getNumber('PENDING_DEPLOYMENT_TTL')) ?? DEFAULT_PENDING_DEPLOYMENT_TTL_MS
    const cutoff = new Date(Date.now() - pendingTtlMs)
    const pendingResult = await database.query<{
      entity_id: string
      entity: { content?: Array<{ hash: string }> }
    }>(SQL`SELECT entity_id, entity FROM pending_scenes WHERE created_at >= ${cutoff}`)
    pendingResult.rows.forEach((row) => {
      activeKeys.add(row.entity_id)
      activeKeys.add(`${row.entity_id}.auth`)
      if (row.entity.content) {
        for (const file of row.entity.content) {
          activeKeys.add(file.hash)
        }
      }
    })

    logger.info(`Done in ${formatSecs(Date.now() - start)}. Database contains ${activeKeys.size} active keys.`)

    return activeKeys
  }

  logger.info('Starting garbage collection...')

  const activeKeys = await getAllActiveKeys()

  logger.info('Getting keys from storage that are not currently active...')
  const start = Date.now()
  let totalRemovedKeys = 0
  const batch = new Set<string>()
  for await (const key of storage.allFileIds()) {
    if (!activeKeys.has(key)) {
      batch.add(key)
    }

    if (batch.size === 1000) {
      logger.info(`Deleting a batch of ${batch.size} keys from storage...`)
      await storage.delete([...batch])
      totalRemovedKeys += batch.size
      batch.clear()
    }
  }

  if (batch.size > 0) {
    logger.info(`Deleting a batch of ${batch.size} keys from storage...`)
    await storage.delete([...batch])
    totalRemovedKeys += batch.size
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
