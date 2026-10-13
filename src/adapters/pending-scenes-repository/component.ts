import SQL from 'sql-template-strings'
import { AppComponents } from '../../types'
import { raceWithSignal } from '../../logic/concurrency'
import { Query } from '../upload-transaction'
import {
  getPublishedContentKeys,
  getReferencedContentKeys as readReferencedContentKeys,
  pendingExpiryCutoff
} from '../content-references'
import {
  BudgetTotals,
  ByteRateWindow,
  CompletedUpload,
  ExpiredUploadCursor,
  FileReceipt,
  IPendingScenesRepository,
  NewPendingScene,
  PendingSceneRecord,
  PublicationRecord
} from './types'

type PendingSceneRow = {
  entity_id: string
  world_name: string
  parcels: string[]
  deployer: string
  created_at: Date
  updated_at: Date
  initialized: boolean
}

function toRecord(row: PendingSceneRow): PendingSceneRecord {
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
 * Creates the SQL over pending uploads, their files, byte-rate windows and completion receipts.
 * Transactions are opened by the caller, which passes their query function in.
 * @param components The database pool.
 * @returns Pending upload persistence.
 */
export async function createPendingScenesRepository(
  components: Pick<AppComponents, 'database'>
): Promise<IPendingScenesRepository> {
  const { database } = components

  async function getLive(
    entityId: string,
    cutoff: Date,
    signal?: AbortSignal
  ): Promise<PendingSceneRecord | undefined> {
    const result = await raceWithSignal(
      database.query<PendingSceneRow>(SQL`
      SELECT entity_id, world_name, parcels, deployer, created_at, updated_at, initialized
      FROM pending_scenes WHERE entity_id = ${entityId} AND created_at > ${cutoff}`),
      signal
    )
    return result.rows[0] ? toRecord(result.rows[0]) : undefined
  }

  async function getPublishedContent(hashes: string[], signal?: AbortSignal): Promise<Set<string>> {
    if (!hashes.length) return new Set()
    return raceWithSignal(getPublishedContentKeys(database, hashes), signal)
  }

  async function getReferencedContentKeys(ttlMs: number, candidates: string[]): Promise<Set<string>> {
    return readReferencedContentKeys(database, ttlMs, candidates)
  }

  async function lockDeployer(query: Query, deployer: string): Promise<void> {
    await query(SQL`SELECT pg_advisory_xact_lock(hashtextextended(${'pending_deployer:' + deployer}, 0))`)
  }

  async function findRecord(query: Query, entityId: string): Promise<PendingSceneRecord | undefined> {
    const existing = await query<PendingSceneRow>(SQL`SELECT entity_id, world_name, parcels, deployer,
        created_at, updated_at, initialized FROM pending_scenes WHERE entity_id = ${entityId}`)
    return existing.rows[0] ? toRecord(existing.rows[0]) : undefined
  }

  async function countByDeployer(query: Query, deployer: string): Promise<{ count: number; oldest: Date | null }> {
    const count = await query<{ count: string; oldest: Date | null }>(
      SQL`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM pending_scenes WHERE deployer = ${deployer}`
    )
    return { count: Number(count.rows[0].count), oldest: count.rows[0].oldest }
  }

  async function insert(query: Query, scene: NewPendingScene): Promise<PendingSceneRecord> {
    const result = await query<PendingSceneRow>(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at)
        VALUES (${scene.entityId}, ${scene.worldName}, ${scene.parcels}::text[], ${scene.entity}::jsonb, ${scene.deployer}, ${scene.createdAt})
        RETURNING entity_id, world_name, parcels, deployer, created_at, updated_at, initialized`)
    return toRecord(result.rows[0])
  }

  async function getOwner(
    entityId: string,
    signal?: AbortSignal
  ): Promise<{ deployer: string; createdAt: Date } | undefined> {
    const owner = await raceWithSignal(
      database.query<{ deployer: string; created_at: Date }>(
        SQL`SELECT deployer, created_at FROM pending_scenes WHERE entity_id = ${entityId}`
      ),
      signal
    )
    return owner.rows[0] ? { deployer: owner.rows[0].deployer, createdAt: owner.rows[0].created_at } : undefined
  }

  async function chargeByteRate(deployer: string, bytes: number, signal?: AbortSignal): Promise<ByteRateWindow> {
    const rate = await raceWithSignal(
      database.query<{ bytes: string; retry_after: number }>(SQL`
      INSERT INTO partial_upload_rates (deployer, window_started, bytes) VALUES (${deployer}, now(), ${bytes})
      ON CONFLICT (deployer) DO UPDATE SET
        bytes = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
          THEN EXCLUDED.bytes ELSE partial_upload_rates.bytes + EXCLUDED.bytes END,
        window_started = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
          THEN now() ELSE partial_upload_rates.window_started END
      RETURNING bytes,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM window_started + interval '1 minute' - now())))::int AS retry_after`),
      signal
    )
    return { bytes: BigInt(rate.rows[0].bytes), retryAfterSeconds: rate.rows[0].retry_after }
  }

  async function lockBudget(query: Query): Promise<void> {
    await query(SQL`SELECT pg_advisory_xact_lock(hashtextextended('partial-upload-budget', 0))`)
  }

  async function upsertFiles(query: Query, entityId: string, receipts: FileReceipt[]): Promise<void> {
    await query(SQL`INSERT INTO pending_scene_files (entity_id, hash, size, stored, charged)
          SELECT ${entityId}, r.hash, r.size, r.stored, r.charged
          FROM jsonb_to_recordset(${JSON.stringify(receipts)}::jsonb)
            AS r(hash text, size bigint, stored boolean, charged boolean)
          ON CONFLICT (entity_id, hash) DO UPDATE
          SET size = GREATEST(pending_scene_files.size, EXCLUDED.size),
              stored = pending_scene_files.stored OR EXCLUDED.stored,
              charged = pending_scene_files.charged OR EXCLUDED.charged`)
  }

  async function refreshReservedBytes(query: Query, entityId: string): Promise<void> {
    await query(SQL`UPDATE pending_scenes SET reserved_bytes = (
        SELECT COALESCE(SUM(size) FILTER (WHERE charged), 0) FROM pending_scene_files WHERE entity_id = ${entityId}
      ) WHERE entity_id = ${entityId}`)
  }

  async function getBudgetTotals(query: Query, entityId: string, deployer: string): Promise<BudgetTotals> {
    const totals = await query<{
      account: string
      total: string
      own: string
      scene: string
      account_oldest: Date | null
      oldest: Date | null
    }>(SQL`
        SELECT COALESCE(SUM(reserved_bytes) FILTER (WHERE deployer = ${deployer}), 0)::text AS account,
          COALESCE(SUM(reserved_bytes), 0)::text AS total,
          COALESCE(SUM(reserved_bytes) FILTER (WHERE entity_id = ${entityId}), 0)::text AS own,
          MIN(created_at) FILTER (WHERE deployer = ${deployer} AND reserved_bytes > 0) AS account_oldest,
          MIN(created_at) FILTER (WHERE reserved_bytes > 0) AS oldest,
          (SELECT COALESCE(SUM(size), 0)::text FROM pending_scene_files
            WHERE entity_id = ${entityId} AND hash != ${entityId}) AS scene
        FROM pending_scenes`)
    const row = totals.rows[0]
    return {
      account: BigInt(row.account),
      total: BigInt(row.total),
      own: BigInt(row.own),
      scene: BigInt(row.scene),
      accountOldest: row.account_oldest,
      oldest: row.oldest
    }
  }

  async function discardUnadmitted(entityId: string): Promise<void> {
    await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId} AND reserved_bytes = 0
      AND NOT EXISTS (SELECT 1 FROM pending_scene_files WHERE entity_id = ${entityId})`)
  }

  async function recordStored(query: Query, entityId: string, hashes: string[]): Promise<number> {
    await query(
      SQL`UPDATE pending_scene_files SET stored = true WHERE entity_id = ${entityId} AND hash = ANY(${hashes}::text[])`
    )
    const batches = await query<{ batches: number }>(SQL`UPDATE pending_scenes
          SET batches = batches + 1, initialized = true
          WHERE entity_id = ${entityId} RETURNING batches`)
    return batches.rows[0]?.batches ?? 0
  }

  async function getProgress(entityId: string, signal?: AbortSignal): Promise<Map<string, number>> {
    const result = await raceWithSignal(
      database.query<{ hash: string; size: string }>(SQL`
      SELECT hash, size FROM pending_scene_files WHERE entity_id = ${entityId} AND stored`),
      signal
    )
    return new Map(result.rows.map((row) => [row.hash, Number(row.size)]))
  }

  async function getCompleted(
    entityId: string,
    deployer: string,
    completedSince: Date,
    signal?: AbortSignal
  ): Promise<CompletedUpload | undefined> {
    const result = await raceWithSignal(
      database.query<{ world_name: string; parcels: string[]; completed_at: Date }>(SQL`
      SELECT world_name, parcels, completed_at FROM completed_scene_uploads
      WHERE entity_id = ${entityId} AND deployer = ${deployer}
        AND completed_at >= ${completedSince}`),
      signal
    )
    const row = result.rows[0]
    return row
      ? { worldName: row.world_name, parcels: row.parcels, creationTimestamp: row.completed_at.getTime() }
      : undefined
  }

  async function recordPublication(
    query: Query,
    publication: PublicationRecord
  ): Promise<{ consumed: boolean; live: boolean }> {
    const { entityId } = publication
    // The completion receipt commits with the publication and survives pending cleanup, replacement,
    // undeployment and disconnects; only a partial finalizer gets one. It tracks the entity's latest
    // publication, so re-publishing the entity after an undeploy replaces or drops it.
    if (publication.completesPartialUpload) {
      await query(SQL`
          INSERT INTO completed_scene_uploads (entity_id, deployer, world_name, parcels, completed_at)
          VALUES (${entityId}, ${publication.deployer}, ${publication.worldName}, ${publication.parcels}::text[],
            ${publication.publishedAt})
          ON CONFLICT (entity_id) DO UPDATE SET deployer = EXCLUDED.deployer, world_name = EXCLUDED.world_name,
            parcels = EXCLUDED.parcels, completed_at = EXCLUDED.completed_at
        `)
    } else {
      await query(SQL`DELETE FROM completed_scene_uploads WHERE entity_id = ${entityId}`)
    }
    // Any publication of the entity supersedes its pending upload, whose staged files are now stored.
    const ttlMs = publication.completesPartialUpload?.ttlMs
    const pendingUpload = await query<{ live: boolean }>(
      SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId} RETURNING `.append(
        ttlMs === undefined
          ? SQL`true AS live`
          : SQL`created_at > `.append(pendingExpiryCutoff(ttlMs)).append(' AS live')
      )
    )
    const row = pendingUpload.rows[0]
    return { consumed: !!row, live: !!row?.live }
  }

  async function deleteByEntityId(entityId: string): Promise<void> {
    // Do not drop the accounting of an upload that has never committed.
    await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId}
      AND EXISTS (SELECT 1 FROM world_scenes WHERE entity_id = ${entityId})`)
  }

  async function listExpired(
    ttlMs: number,
    after: ExpiredUploadCursor | undefined,
    limit: number
  ): Promise<ExpiredUploadCursor[]> {
    const query = SQL`SELECT entity_id, created_at::text AS cursor FROM pending_scenes WHERE created_at <= `.append(
      pendingExpiryCutoff(ttlMs)
    )
    if (after) {
      query.append(SQL` AND (created_at, entity_id) > (${after.createdAt}::timestamptz, ${after.entityId})`)
    }
    query.append(SQL` ORDER BY created_at, entity_id LIMIT ${limit}`)
    const page = await database.query<{ entity_id: string; cursor: string }>(query)
    return page.rows.map((row) => ({ entityId: row.entity_id, createdAt: row.cursor }))
  }

  async function getUploadKeys(entityId: string): Promise<string[]> {
    const keys = await database.query<{ hash: string }>(SQL`
      SELECT hash FROM pending_scene_files WHERE entity_id = ${entityId}
      UNION SELECT ${entityId} UNION SELECT ${entityId + '.auth'}`)
    return keys.rows.map((row) => row.hash)
  }

  async function releaseExpired(entityId: string, ttlMs: number): Promise<void> {
    await database.query(
      SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId} AND created_at <= `.append(
        pendingExpiryCutoff(ttlMs)
      )
    )
  }

  async function pruneCompleted(before: Date): Promise<void> {
    await database.query(SQL`DELETE FROM completed_scene_uploads WHERE completed_at < ${before}`)
  }

  async function pruneByteRates(): Promise<void> {
    await database.query(SQL`DELETE FROM partial_upload_rates WHERE window_started < now() - interval '1 minute'`)
  }

  async function getChargedBytes(cutoff: Date): Promise<{ bytes: number; expired: number }> {
    const totals = await database.query<{ bytes: string; expired: string }>(SQL`
      SELECT COALESCE(SUM(f.size) FILTER (WHERE f.charged), 0)::text AS bytes,
        COALESCE(SUM(f.size) FILTER (WHERE f.charged AND p.created_at <= ${cutoff}), 0)::text AS expired
      FROM pending_scene_files f JOIN pending_scenes p USING (entity_id)`)
    return { bytes: Number(totals.rows[0].bytes), expired: Number(totals.rows[0].expired) }
  }

  async function countUploads(cutoff: Date): Promise<{ live: number; expired: number }> {
    const uploads = await database.query<{ live: string; expired: string }>(SQL`
      SELECT COUNT(*) FILTER (WHERE created_at > ${cutoff})::text AS live,
        COUNT(*) FILTER (WHERE created_at <= ${cutoff})::text AS expired
      FROM pending_scenes`)
    return { live: Number(uploads.rows[0].live), expired: Number(uploads.rows[0].expired) }
  }

  return {
    getLive,
    getPublishedContent,
    getReferencedContentKeys,
    lockDeployer,
    findRecord,
    countByDeployer,
    insert,
    getOwner,
    chargeByteRate,
    lockBudget,
    upsertFiles,
    refreshReservedBytes,
    getBudgetTotals,
    discardUnadmitted,
    recordStored,
    getProgress,
    getCompleted,
    recordPublication,
    deleteByEntityId,
    listExpired,
    getUploadKeys,
    releaseExpired,
    pruneCompleted,
    pruneByteRates,
    getChargedBytes,
    countUploads
  }
}
