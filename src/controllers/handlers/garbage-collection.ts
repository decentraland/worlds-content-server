import { HandlerContextWithPath, WorldRecord } from '../../types'
import SQL from 'sql-template-strings'
import { IHttpServerComponent } from '@well-known-components/interfaces'

function formatSecs(millis: number): string {
  return `${(millis / 1000).toFixed(2)} secs`
}

export async function garbageCollectionHandler(
  context: HandlerContextWithPath<'database' | 'logs' | 'storage', '/gc'>
): Promise<IHttpServerComponent.IResponse> {
  const { database, logs, storage } = context.components
  const logger = logs.getLogger('garbage-collection')

  async function getAllActiveKeys() {
    const start = Date.now()
    logger.info('Getting all keys active in the database...')

    const activeKeys = new Set<string>()
    const result = await database.query<WorldRecord>(
      SQL`SELECT *
          FROM worlds
          WHERE worlds.entity IS NOT NULL`
    )
    result.rows.forEach((row) => {
      // Add entity file and deployment auth-chain
      activeKeys.add(row.entity_id)
      activeKeys.add(`${row.entity_id}.auth`)

      // Add all referenced content files
      for (const file of row.entity.content) {
        activeKeys.add(file.hash)
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
