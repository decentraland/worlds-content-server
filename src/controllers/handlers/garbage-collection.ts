import { HandlerContextWithPath, WorldRecord } from '../../types'
import SQL from 'sql-template-strings'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { chunks } from '../../logic/utils'

function formatSecs(millis: number): string {
  return `${(millis / 1000).toFixed(2)} secs`
}

export async function garbageCollectionHandler(
  context: HandlerContextWithPath<'database' | 'logs' | 'storage', '/gc'>
): Promise<IHttpServerComponent.IResponse> {
  const { database, logs, storage } = context.components
  const logger = logs.getLogger('garbage-collection')

  async function getBucketUnusedKeys(usedKeys: Set<string>) {
    const start = Date.now()
    logger.info('Getting keys from storage that are not currently active...')
    const unusedKeys = new Set<string>()
    for await (const key of storage.allFileIds()) {
      if (!usedKeys.has(key)) {
        unusedKeys.add(key)
      }
    }
    logger.info(
      `Done in ${formatSecs(Date.now() - start)}. Storage contains ${unusedKeys.size} keys that are not active.`
    )
    return unusedKeys
  }

  async function getAllUsedKeys() {
    const start = Date.now()
    logger.info('Getting all used keys from the database...')

    const allUsedKeys = new Set<string>()
    const result = await database.query<WorldRecord>(
      SQL`SELECT *
          FROM worlds
          WHERE worlds.entity IS NOT NULL`
    )
    result.rows.forEach((row) => {
      // Add entity file and deployment auth-chain
      allUsedKeys.add(row.entity_id)
      allUsedKeys.add(`${row.entity_id}.auth`)

      // Add all referenced content files
      for (const file of row.entity.content) {
        allUsedKeys.add(file.hash)
      }
    })

    logger.info(`Done in ${formatSecs(Date.now() - start)}. Database contains ${allUsedKeys.size} keys.`)

    return allUsedKeys
  }

  logger.info('Starting garbage collection...')

  const allUsedKeys = await getAllUsedKeys()
  const keysToBeRemoved = await getBucketUnusedKeys(allUsedKeys)

  logger.log(`Storage contains ${keysToBeRemoved.size} unused keys that should be removed.`)
  for (const chunk of chunks([...keysToBeRemoved], 1000)) {
    logger.info(`Deleting a batch of ${chunk.length} keys from storage...`)
    await storage.delete(chunk)
  }

  logger.info('Garbage collection finished.')

  return {
    status: 200,
    body: {
      message: `Garbage collection removed ${keysToBeRemoved.size} unused keys.`
    }
  }
}
