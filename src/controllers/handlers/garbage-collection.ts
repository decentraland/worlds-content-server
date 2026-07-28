import SQL from 'sql-template-strings'
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

  // Keys (entity file, its auth blob, and referenced content hashes) of world_scenes rows deployed/
  // touched at or after `since`. The activeKeys snapshot is taken once at the start of the sweep; a
  // partial upload that FINALIZES mid-sweep moves its protection from pending_scenes (row deleted at
  // finalize) into world_scenes (a row the snapshot predates), so without this the just-deployed
  // scene's reused content could be reclaimed. Bounded by `updated_at >= since` so it only scans the
  // few scenes deployed during this sweep, not the whole table.
  async function getKeysDeployedSince(since: Date): Promise<Set<string>> {
    const result = await database.query<{ entity_id: string; entity: { content?: Array<{ hash: string }> } }>(
      SQL`SELECT entity_id, entity FROM world_scenes WHERE entity IS NOT NULL AND updated_at >= ${since}`
    )
    const keys = new Set<string>()
    for (const row of result.rows) {
      keys.add(row.entity_id)
      keys.add(`${row.entity_id}.auth`)
      for (const file of row.entity.content ?? []) {
        keys.add(file.hash)
      }
    }
    return keys
  }

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

  // Anchor the mid-sweep world_scenes re-check strictly BEFORE the activeKeys snapshot (minus a margin
  // for app/DB clock skew), so any scene finalized during the sweep is caught by getKeysDeployedSince.
  const sweepStart = new Date(Date.now() - 60_000)

  const activeKeys = await getAllActiveKeys()

  logger.info('Getting keys from storage that are not currently active...')
  const start = Date.now()
  let totalRemovedKeys = 0
  const batch = new Set<string>()

  // Re-check right before deleting: the activeKeys snapshot was taken once, but a partial upload can
  // START (its pending row) or FINALIZE (a new world_scenes row) mid-sweep. Subtract both the current
  // pending keys and the keys of scenes deployed since the sweep began, so neither a freshly-staged nor
  // a just-finalized upload's content is reclaimed in flight. Both sets are small (pending_scenes is
  // tiny; the deployed-since set is bounded by updated_at), so the per-batch re-query is cheap.
  const deleteBatch = async (keys: Set<string>): Promise<void> => {
    const [pendingNow, deployedSinceStart] = await Promise.all([
      pendingScenesManager.getActivePendingKeys(),
      getKeysDeployedSince(sweepStart)
    ])
    const toDelete = [...keys].filter((key) => !pendingNow.has(key) && !deployedSinceStart.has(key))
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
