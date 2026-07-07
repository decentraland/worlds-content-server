import SQL from 'sql-template-strings'
import { Entity } from '@dcl/schemas'
import { AppComponents, IPendingScenesManager, PendingScene, UpsertPendingScene } from '../types'

const DEFAULT_PENDING_DEPLOYMENT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

type PendingSceneRow = {
  entity_id: string
  world_name: string
  parcels: string[]
  entity: Entity
  deployer: string
  created_at: Date
  updated_at: Date
}

function toPendingScene(row: PendingSceneRow): PendingScene {
  return {
    entityId: row.entity_id,
    worldName: row.world_name,
    parcels: row.parcels,
    entity: row.entity,
    deployer: row.deployer,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createPendingScenesManager(
  components: Pick<AppComponents, 'config' | 'database' | 'logs'>
): Promise<IPendingScenesManager> {
  const { config, database, logs } = components
  const logger = logs.getLogger('pending-scenes-manager')
  const ttlMs = (await config.getNumber('PENDING_DEPLOYMENT_TTL')) ?? DEFAULT_PENDING_DEPLOYMENT_TTL_MS

  async function getByEntityId(entityId: string): Promise<PendingScene | undefined> {
    const cutoff = new Date(Date.now() - ttlMs)
    const result = await database.query<PendingSceneRow>(
      SQL`SELECT entity_id, world_name, parcels, entity, deployer, created_at, updated_at
          FROM pending_scenes
          WHERE entity_id = ${entityId} AND created_at >= ${cutoff}
          LIMIT 1`
    )
    return result.rows.length > 0 ? toPendingScene(result.rows[0]) : undefined
  }

  async function upsert(input: UpsertPendingScene): Promise<PendingScene> {
    const worldName = input.worldName.toLowerCase()
    const expiryCutoff = new Date(Date.now() - ttlMs)

    return await database.withAsyncContextTransaction(async () => {
      // Serialize the "replace overlapping + insert" critical section per world (also across
      // processes) so two concurrent uploads for the same world+parcels can't both insert.
      await database.query(SQL`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_scenes:' + worldName}, 0))`)

      // Purge expired rows and replace any non-expired pending scene of this world whose parcels
      // overlap the new one (a different entity id) — enforcing one pending upload per world+parcel.
      await database.query(SQL`
        DELETE FROM pending_scenes
        WHERE created_at < ${expiryCutoff}
           OR (world_name = ${worldName} AND parcels && ${input.parcels}::text[] AND entity_id != ${input.entityId})
      `)

      const result = await database.query<PendingSceneRow>(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at, updated_at)
        VALUES (${input.entityId}, ${worldName}, ${input.parcels}::text[], ${input.entity}::jsonb, ${input.deployer.toLowerCase()}, now(), now())
        ON CONFLICT (entity_id) DO UPDATE SET updated_at = now()
        RETURNING entity_id, world_name, parcels, entity, deployer, created_at, updated_at
      `)
      return toPendingScene(result.rows[0])
    })
  }

  async function deleteByEntityId(entityId: string): Promise<void> {
    await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId}`)
  }

  async function deleteExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - ttlMs)
    const result = await database.query(SQL`DELETE FROM pending_scenes WHERE created_at < ${cutoff}`)
    const removed = result.rowCount ?? 0
    if (removed > 0) {
      logger.info(`Removed ${removed} expired pending scene(s)`)
    }
    return removed
  }

  async function getActivePendingKeys(): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - ttlMs)
    const result = await database.query<{ entity_id: string; entity: Entity }>(
      SQL`SELECT entity_id, entity FROM pending_scenes WHERE created_at >= ${cutoff}`
    )
    const keys = new Set<string>()
    for (const row of result.rows) {
      // The staged entity JSON, its auth-chain blob, and every content file it references are all
      // referenced by the in-flight upload even though no world_scenes row exists yet.
      keys.add(row.entity_id)
      keys.add(`${row.entity_id}.auth`)
      for (const file of row.entity.content ?? []) {
        keys.add(file.hash)
      }
    }
    return keys
  }

  return { getByEntityId, upsert, deleteByEntityId, deleteExpired, getActivePendingKeys }
}
