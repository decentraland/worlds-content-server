import SQL from 'sql-template-strings'
import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents } from '../../types'
import { getPositiveInteger, raceWithSignal } from '../../logic/concurrency'
import { withUploadTransaction } from '../upload-transaction'
import { getReferencedContentKeys } from '../content-references'
import { IPendingScenesManager, PendingScene, UpsertPendingScene, FileReceipt } from './types'

type PendingSceneRow = {
  entity_id: string
  world_name: string
  parcels: string[]
  deployer: string
  created_at: Date
  updated_at: Date
  initialized: boolean
}

function toPendingScene(row: PendingSceneRow): PendingScene {
  return {
    entityId: row.entity_id,
    worldName: row.world_name,
    parcels: row.parcels,
    deployer: row.deployer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    initialized: row.initialized
  }
}

/**
 * Creates durable entity-keyed staging, progress and admission accounting. All staging mutations run
 * under the caller's shared content lock. Cleanup takes the exclusive lock, including physical deletes.
 * @param components Persistence, storage, lock and telemetry dependencies.
 * @returns Upload lifecycle and atomic admission operations.
 */
export async function createPendingScenesManager(
  components: Pick<AppComponents, 'config' | 'database' | 'logs' | 'metrics' | 'storage' | 'contentLocks'>
): Promise<IPendingScenesManager> {
  const { config, database, logs, metrics, storage, contentLocks } = components
  const logger = logs.getLogger('pending-scenes-manager')
  const ttlMs = await getPositiveInteger(config, 'PENDING_DEPLOYMENT_TTL', 24 * 60 * 60 * 1000)
  const accountBytes = BigInt(await getPositiveInteger(config, 'MAX_PENDING_BYTES_PER_DEPLOYER', 1024 ** 3))
  const globalBytes = BigInt(await getPositiveInteger(config, 'MAX_PENDING_BYTES', 50 * 1024 ** 3))
  const bytesPerMinute = await getPositiveInteger(config, 'MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE', 512 * 1024 ** 2)
  const completionTtl = await getPositiveInteger(config, 'COMPLETED_UPLOAD_TTL', 24 * 60 * 60 * 1000)

  async function getByEntityId(entityId: string, signal?: AbortSignal): Promise<PendingScene | undefined> {
    const result = await raceWithSignal(
      database.query<PendingSceneRow>(SQL`
      SELECT entity_id, world_name, parcels, deployer, created_at, updated_at, initialized
      FROM pending_scenes WHERE entity_id = ${entityId} AND created_at >= ${new Date(Date.now() - ttlMs)}`),
      signal
    )
    return result.rows[0] ? toPendingScene(result.rows[0]) : undefined
  }

  async function upsert(
    input: UpsertPendingScene,
    limit: { maxPendingPerDeployer: number },
    signal?: AbortSignal
  ): Promise<PendingScene> {
    const deployer = input.deployer.toLowerCase()
    return withUploadTransaction(
      database,
      async (query) => {
        await query(SQL`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_deployer:' + deployer}, 0))`)
        const existing = await query<PendingSceneRow>(SQL`SELECT entity_id, world_name, parcels, deployer,
        created_at, updated_at, initialized FROM pending_scenes WHERE entity_id = ${input.entityId}`)
        if (existing.rows[0]) {
          if (existing.rows[0].created_at.getTime() < Date.now() - ttlMs) {
            throw new InvalidRequestError('This upload expired. Create a new entity with a fresh timestamp.')
          }
          return toPendingScene(existing.rows[0])
        }
        const count = await query<{ count: string }>(
          SQL`SELECT COUNT(*) AS count FROM pending_scenes WHERE deployer = ${deployer}`
        )
        if (Number(count.rows[0].count) >= limit.maxPendingPerDeployer) {
          throw new InvalidRequestError(
            `Too many partial uploads in progress for this account (max ${limit.maxPendingPerDeployer}). Complete an upload or wait for expired uploads to be cleaned up.`
          )
        }
        const result = await query<PendingSceneRow>(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer)
        VALUES (${input.entityId}, ${input.worldName.toLowerCase()}, ${input.parcels}::text[], ${input.entity}::jsonb, ${deployer})
        RETURNING entity_id, world_name, parcels, deployer, created_at, updated_at, initialized`)
        return toPendingScene(result.rows[0])
      },
      signal
    )
  }

  async function reserve(
    entityId: string,
    receipts: FileReceipt[],
    maxSceneBytes: bigint,
    incomingBytes: number,
    signal?: AbortSignal
  ): Promise<void> {
    await withUploadTransaction(
      database,
      async (query) => {
        // One short global admission critical section makes both aggregate budgets atomic. No storage
        // or external validation occurs under this lock. Expired reservations stay counted until cleanup.
        await query(SQL`SELECT pg_advisory_xact_lock(hashtextextended('partial-upload-budget', 0))`)
        const owner = await query<{ deployer: string }>(
          SQL`SELECT deployer FROM pending_scenes WHERE entity_id = ${entityId}`
        )
        if (!owner.rows[0]) throw new InvalidRequestError('Upload no longer exists; resend its manifest.')
        const deployer = owner.rows[0].deployer
        if (receipts.length) {
          await query(SQL`INSERT INTO pending_scene_files (entity_id, hash, size, stored)
          SELECT ${entityId}, r.hash, r.size, r.stored
          FROM jsonb_to_recordset(${JSON.stringify(receipts)}::jsonb) AS r(hash text, size bigint, stored boolean)
          ON CONFLICT (entity_id, hash) DO UPDATE
          SET size = GREATEST(pending_scene_files.size, EXCLUDED.size),
              stored = pending_scene_files.stored OR EXCLUDED.stored`)
        }
        await query(SQL`UPDATE pending_scenes SET reserved_bytes = (
        SELECT COALESCE(SUM(size), 0) FROM pending_scene_files WHERE entity_id = ${entityId}
      ) WHERE entity_id = ${entityId}`)
        const totals = await query<{ account: string; total: string; scene: string }>(SQL`
        SELECT COALESCE(SUM(reserved_bytes) FILTER (WHERE deployer = ${deployer}), 0)::text AS account,
          COALESCE(SUM(reserved_bytes), 0)::text AS total,
          (SELECT COALESCE(SUM(size), 0)::text FROM pending_scene_files
            WHERE entity_id = ${entityId} AND hash != ${entityId}) AS scene
        FROM pending_scenes`)
        const total = totals.rows[0]
        if (BigInt(total.scene) > maxSceneBytes)
          throw new InvalidRequestError('Deployment failed: The deployment is too big.')
        if (BigInt(total.account) > accountBytes || BigInt(total.total) > globalBytes) {
          throw new InvalidRequestError('Partial upload storage budget exceeded. Complete uploads or wait for cleanup.')
        }
        const rate = await query<{ bytes: string }>(SQL`
        INSERT INTO partial_upload_rates (deployer, window_started, bytes) VALUES (${deployer}, now(), ${incomingBytes})
        ON CONFLICT (deployer) DO UPDATE SET
          bytes = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
            THEN EXCLUDED.bytes ELSE partial_upload_rates.bytes + EXCLUDED.bytes END,
          window_started = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
            THEN now() ELSE partial_upload_rates.window_started END
        RETURNING bytes`)
        if (BigInt(rate.rows[0].bytes) > BigInt(bytesPerMinute)) {
          throw new InvalidRequestError('Partial upload byte rate exceeded. Retry after one minute.')
        }
        metrics.observe('partial_upload_reserved_bytes', {}, Number(total.total))
      },
      signal
    )
  }

  async function recordStored(
    entityId: string,
    hashes: string[],
    initialized: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    await withUploadTransaction(
      database,
      async (query) => {
        await query(
          SQL`UPDATE pending_scene_files SET stored = true WHERE entity_id = ${entityId} AND hash = ANY(${hashes}::text[])`
        )
        if (initialized) await query(SQL`UPDATE pending_scenes SET initialized = true WHERE entity_id = ${entityId}`)
      },
      signal
    )
  }

  async function getProgress(entityId: string, signal?: AbortSignal): Promise<Map<string, number>> {
    const result = await raceWithSignal(
      database.query<{ hash: string; size: string }>(SQL`
      SELECT hash, size FROM pending_scene_files WHERE entity_id = ${entityId} AND stored`),
      signal
    )
    return new Map(result.rows.map((row) => [row.hash, Number(row.size)]))
  }

  async function markMissing(entityId: string, hashes: string[], signal?: AbortSignal): Promise<void> {
    await withUploadTransaction(
      database,
      async (query) => {
        await query(
          SQL`UPDATE pending_scene_files SET stored = false WHERE entity_id = ${entityId} AND hash = ANY(${hashes}::text[])`
        )
      },
      signal
    )
  }

  async function getCompleted(entityId: string, deployer: string, signal?: AbortSignal) {
    const result = await raceWithSignal(
      database.query<{ world_name: string; parcels: string[]; completed_at: Date }>(SQL`
      SELECT world_name, parcels, completed_at FROM completed_scene_uploads
      WHERE entity_id = ${entityId} AND deployer = ${deployer.toLowerCase()}
        AND completed_at >= ${new Date(Date.now() - completionTtl)}`),
      signal
    )
    const row = result.rows[0]
    return row
      ? { worldName: row.world_name, parcels: row.parcels, creationTimestamp: row.completed_at.getTime() }
      : undefined
  }

  async function deleteByEntityId(entityId: string): Promise<void> {
    // Do not drop the accounting of an upload that has never committed.
    await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId}
      AND EXISTS (SELECT 1 FROM world_scenes WHERE entity_id = ${entityId})`)
  }

  async function deleteExpired(): Promise<number> {
    // Fetch ids without holding up uploads for an entire sweep. Each small physical delete batch
    // gets its own exclusive gate; reservations are released only after every batch succeeds.
    const expired = await database.query<{ entity_id: string }>(SQL`
      SELECT entity_id FROM pending_scenes WHERE created_at < ${new Date(Date.now() - ttlMs)} LIMIT 100`)
    let removed = 0
    for (const { entity_id: entityId } of expired.rows) {
      const keys = await database.query<{ hash: string }>(SQL`
        SELECT hash FROM pending_scene_files WHERE entity_id = ${entityId}
        UNION SELECT ${entityId} UNION SELECT ${entityId + '.auth'}`)
      for (let offset = 0; offset < keys.rows.length; offset += 1000) {
        const batch = keys.rows.slice(offset, offset + 1000).map((row) => row.hash)
        await contentLocks.withWrite(async () => {
          const referenced = await getReferencedContentKeys(database, new Date(Date.now() - ttlMs), batch)
          const orphaned = batch.filter((hash) => !referenced.has(hash))
          if (orphaned.length) await storage.delete(orphaned)
        })
      }
      await database.query(
        SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId} AND created_at < ${new Date(Date.now() - ttlMs)}`
      )
      removed++
    }
    await database.query(
      SQL`DELETE FROM completed_scene_uploads WHERE completed_at < ${new Date(Date.now() - completionTtl)}`
    )
    await database.query(SQL`DELETE FROM partial_upload_rates WHERE window_started < now() - interval '1 minute'`)
    const totals = await database.query<{ bytes: string; expired: string }>(SQL`
      SELECT COALESCE(SUM(f.size), 0)::text AS bytes,
        COALESCE(SUM(f.size) FILTER (WHERE p.created_at < ${new Date(Date.now() - ttlMs)}), 0)::text AS expired
      FROM pending_scene_files f JOIN pending_scenes p USING (entity_id)`)
    metrics.observe('partial_upload_reserved_bytes', {}, Number(totals.rows[0].bytes))
    metrics.observe('partial_upload_cleanup_backlog_bytes', {}, Number(totals.rows[0].expired))
    logger.info('Cleaned expired uploads', { removed })
    return removed
  }

  async function getActivePendingKeys(): Promise<Set<string>> {
    const result = await database.query<{ entity_id: string; hashes: string[] }>(SQL`
      SELECT entity_id, ARRAY(SELECT jsonb_array_elements(entity->'content')->>'hash'
        WHERE jsonb_typeof(entity->'content') = 'array') AS hashes
      FROM pending_scenes WHERE created_at >= ${new Date(Date.now() - ttlMs)}`)
    return new Set(result.rows.flatMap((row) => [row.entity_id, row.entity_id + '.auth', ...row.hashes]))
  }

  return {
    ttlMs,
    getByEntityId,
    upsert,
    reserve,
    recordStored,
    getProgress,
    markMissing,
    getCompleted,
    deleteByEntityId,
    deleteExpired,
    getActivePendingKeys
  }
}
