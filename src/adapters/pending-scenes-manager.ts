import SQL from 'sql-template-strings'
import { Entity } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/http-commons'
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

  async function upsert(
    input: UpsertPendingScene,
    limit: { maxPendingPerDeployer: number; isNewUpload: boolean }
  ): Promise<PendingScene> {
    const worldName = input.worldName.toLowerCase()
    const deployer = input.deployer.toLowerCase()
    const expiryCutoff = new Date(Date.now() - ttlMs)

    return await database.withAsyncContextTransaction(async () => {
      // Per-deployer lock FIRST (acquired before the per-world lock below, a consistent order that can't
      // deadlock). It serializes a deployer's concurrent staging requests — even to different worlds —
      // so the concurrent-pending cap can't be raced: without it, several new uploads could each read a
      // count below the cap and then all insert.
      await database.query(SQL`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_deployer:' + deployer}, 0))`)
      if (limit.isNewUpload) {
        const active = await countActiveByDeployer(deployer)
        if (active >= limit.maxPendingPerDeployer) {
          throw new InvalidRequestError(
            `Too many partial uploads in progress for this account (max ${limit.maxPendingPerDeployer}). Finalize or abandon an existing upload before starting another.`
          )
        }
      }

      // Serialize the "replace overlapping + insert" critical section per world (also across
      // processes) so two concurrent uploads for the same world+parcels can't both insert.
      await database.query(SQL`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_scenes:' + worldName}, 0))`)

      // The single pending slot per parcel set goes to the NEWEST scene (Decentraland deployment
      // ordering: greater entity.timestamp, tie broken by greater entity id). Reject rather than
      // replace when a strictly-newer overlapping upload is already in flight, so a stale/older upload
      // can't evict a newer competitor's staged content (and two clients can't ping-pong evicting each
      // other). A resume (same entity id) is excluded and never conflicts with itself.
      const newer = await database.query(SQL`
        SELECT 1 FROM pending_scenes
        WHERE world_name = ${worldName}
          AND parcels && ${input.parcels}::text[]
          AND entity_id != ${input.entityId}
          AND created_at >= ${expiryCutoff}
          AND ( (entity->>'timestamp')::bigint > ${input.entity.timestamp}
                OR ((entity->>'timestamp')::bigint = ${input.entity.timestamp} AND entity_id > ${input.entityId}) )
        LIMIT 1
      `)
      if (newer.rowCount > 0) {
        throw new InvalidRequestError('A newer partial upload is already in progress for one or more of these parcels.')
      }

      // Purge expired rows and replace any non-expired pending scene of this world whose parcels
      // overlap the new one (a different entity id). Having rejected the newer-conflict above, every
      // remaining overlapping row is strictly older, so replacing it is the intended "newest wins".
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

  async function countActiveByDeployer(deployer: string): Promise<number> {
    const cutoff = new Date(Date.now() - ttlMs)
    const result = await database.query<{ count: string }>(
      SQL`SELECT COUNT(*) as count FROM pending_scenes
          WHERE deployer = ${deployer.toLowerCase()} AND created_at >= ${cutoff}`
    )
    return parseInt(result.rows[0].count, 10)
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
    // Project only the content hashes out of the entity JSONB instead of shipping every pending
    // scene's full manifest: GC calls this once per delete batch, so on a large sweep the payload
    // size matters more than the (tiny) row count. The jsonb_typeof guard keeps a row whose `content`
    // is absent, null, or a non-array from erroring `jsonb_array_elements` ('cannot extract elements
    // from a scalar') — one such row would otherwise fail the whole query and wedge GC server-wide.
    const result = await database.query<{ entity_id: string; hashes: string[] | null }>(
      SQL`SELECT entity_id,
                 ARRAY(
                   SELECT jsonb_array_elements(entity->'content')->>'hash'
                   WHERE jsonb_typeof(entity->'content') = 'array'
                 ) AS hashes
          FROM pending_scenes
          WHERE created_at >= ${cutoff}`
    )
    const keys = new Set<string>()
    for (const row of result.rows) {
      // The staged entity JSON, its auth-chain blob, and every content file it references are all
      // referenced by the in-flight upload even though no world_scenes row exists yet.
      keys.add(row.entity_id)
      keys.add(`${row.entity_id}.auth`)
      for (const hash of row.hashes ?? []) {
        keys.add(hash)
      }
    }
    return keys
  }

  return { getByEntityId, upsert, deleteByEntityId, deleteExpired, getActivePendingKeys, countActiveByDeployer }
}
