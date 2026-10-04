import SQL from 'sql-template-strings'
import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents } from '../../types'
import { getPositiveInteger, raceWithSignal } from '../../logic/concurrency'
import { withUploadTransaction } from '../upload-transaction'
import { getReferencedContentKeys } from '../content-references'
import { IPendingScenesManager, PendingScene, UpsertPendingScene, FileReceipt } from './types'
import { PartialUploadExpiredError, PartialUploadQuotaExceededError, PartialUploadTooLargeError } from './errors'
import { ContentLockTimeoutError } from '../content-locks/errors'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES, formatBytes } from '../../logic/multipart'

type PendingSceneRow = {
  entity_id: string
  world_name: string
  parcels: string[]
  deployer: string
  created_at: Date
  updated_at: Date
  initialized: boolean
}

/** Default lifetime of a pending (partial) upload, anchored at its first request. */
export const DEFAULT_PENDING_DEPLOYMENT_TTL_MS = 60 * 60 * 1000
/** Default interval between expired-upload cleanup runs. */
export const DEFAULT_PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

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
  const ttlMs = await getPositiveInteger(config, 'PENDING_DEPLOYMENT_TTL', DEFAULT_PENDING_DEPLOYMENT_TTL_MS)
  const cleanupIntervalMs = await getPositiveInteger(
    config,
    'PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS',
    DEFAULT_PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS
  )
  const accountBytes = BigInt(await getPositiveInteger(config, 'MAX_PENDING_BYTES_PER_DEPLOYER', 1024 ** 3))
  const globalBytes = BigInt(await getPositiveInteger(config, 'MAX_PENDING_BYTES', 50 * 1024 ** 3))
  const bytesPerMinute = await getPositiveInteger(config, 'MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE', 512 * 1024 ** 2)
  const completionTtl = await getPositiveInteger(config, 'COMPLETED_UPLOAD_TTL', 24 * 60 * 60 * 1000)
  // Otherwise a valid request or upload could be rejected by its own size forever.
  if (bytesPerMinute < DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES) {
    throw new Error(
      `MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE (${bytesPerMinute}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
    )
  }
  if (globalBytes < accountBytes) {
    throw new Error(
      `MAX_PENDING_BYTES (${globalBytes}) must be at least MAX_PENDING_BYTES_PER_DEPLOYER (${accountBytes}).`
    )
  }

  // When this replica's cleanup last finished; the scheduled sweep runs again one interval later.
  let lastCleanupFinishedAt: number | undefined
  metrics.observe('partial_upload_capacity_bytes', {}, Number(globalBytes))

  // Capacity held by the oldest charged upload frees no earlier than its expiry; once it has expired,
  // only the next cleanup run frees it.
  function retryAfterOldest(oldestCreatedAt: Date | null): number {
    const untilExpiry = oldestCreatedAt ? oldestCreatedAt.getTime() + ttlMs - Date.now() : 0
    const untilCleanup =
      lastCleanupFinishedAt === undefined ? cleanupIntervalMs : lastCleanupFinishedAt + cleanupIntervalMs - Date.now()
    return Math.max(1, Math.ceil((untilExpiry > 0 ? untilExpiry : untilCleanup) / 1000))
  }

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
            throw new PartialUploadExpiredError()
          }
          // Reservations are charged to the upload's creator, so nobody else may add batches to it.
          if (existing.rows[0].deployer !== deployer) {
            throw new InvalidRequestError('This upload was started by another account.')
          }
          return toPendingScene(existing.rows[0])
        }
        // Only cleanup of an expired upload removes one seen earlier; re-creating it would restart it.
        if (input.resumes) throw new PartialUploadExpiredError()
        // A delayed first batch (slow validation or lock waits) may arrive already past its deadline.
        if (input.admittedAt.getTime() < Date.now() - ttlMs) throw new PartialUploadExpiredError()
        const count = await query<{ count: string; oldest: Date | null }>(
          SQL`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM pending_scenes WHERE deployer = ${deployer}`
        )
        if (Number(count.rows[0].count) >= limit.maxPendingPerDeployer) {
          throw new PartialUploadQuotaExceededError(
            'uploads_per_account',
            `Too many partial uploads in progress for this account: ${count.rows[0].count} of the ${limit.maxPendingPerDeployer} allowed. Complete an upload or wait for expired uploads to be cleaned up.`,
            retryAfterOldest(count.rows[0].oldest)
          )
        }
        const result = await query<PendingSceneRow>(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at)
        VALUES (${input.entityId}, ${input.worldName.toLowerCase()}, ${input.parcels}::text[], ${input.entity}::jsonb, ${deployer}, ${input.admittedAt})
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
    const owner = await raceWithSignal(
      database.query<{ deployer: string; created_at: Date }>(
        SQL`SELECT deployer, created_at FROM pending_scenes WHERE entity_id = ${entityId}`
      ),
      signal
    )
    if (!owner.rows[0]) throw new InvalidRequestError('Upload no longer exists; resend its manifest.')
    const deployer = owner.rows[0].deployer
    // Nothing is charged to an upload past its deadline.
    const assertLive = (): void => {
      if (owner.rows[0].created_at.getTime() < Date.now() - ttlMs) throw new PartialUploadExpiredError()
    }
    assertLive()
    // Committed on its own, before admission: the batch was received and processed even if it is then
    // rejected, so repeating rejected batches can't escape the rate limit.
    const rate = await raceWithSignal(
      database.query<{ bytes: string; retry_after: number }>(SQL`
      INSERT INTO partial_upload_rates (deployer, window_started, bytes) VALUES (${deployer}, now(), ${incomingBytes})
      ON CONFLICT (deployer) DO UPDATE SET
        bytes = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
          THEN EXCLUDED.bytes ELSE partial_upload_rates.bytes + EXCLUDED.bytes END,
        window_started = CASE WHEN partial_upload_rates.window_started < now() - interval '1 minute'
          THEN now() ELSE partial_upload_rates.window_started END
      RETURNING bytes,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM window_started + interval '1 minute' - now())))::int AS retry_after`),
      signal
    )
    if (incomingBytes > bytesPerMinute) {
      throw new PartialUploadTooLargeError(
        'bytes_per_minute',
        `This batch is ${formatBytes(incomingBytes)}, above the partial upload limit of ${formatBytes(bytesPerMinute)} per minute. Send smaller batches.`
      )
    }
    if (BigInt(rate.rows[0].bytes) > BigInt(bytesPerMinute)) {
      const retryAfter = rate.rows[0].retry_after
      throw new PartialUploadQuotaExceededError(
        'bytes_per_minute',
        `This account sent ${formatBytes(Number(rate.rows[0].bytes))} of partial uploads this minute, above the limit of ${formatBytes(bytesPerMinute)} per minute. Retry in ${retryAfter} s.`,
        retryAfter
      )
    }
    await withUploadTransaction(
      database,
      async (query) => {
        // One short global admission critical section makes both aggregate budgets atomic. No storage
        // or external validation occurs under this lock. Expired reservations stay counted until cleanup.
        await query(SQL`SELECT pg_advisory_xact_lock(hashtextextended('partial-upload-budget', 0))`)
        assertLive()
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
        const total = totals.rows[0]
        if (BigInt(total.scene) > maxSceneBytes)
          throw new InvalidRequestError('Deployment failed: The deployment is too big.')
        // Over a budget on its own, an upload can never be admitted; the server budget is at least this one.
        if (BigInt(total.own) > accountBytes) {
          throw new PartialUploadTooLargeError(
            'bytes_per_account',
            `This upload needs ${formatBytes(Number(total.own))} of staging, above the per-account partial upload limit of ${formatBytes(Number(accountBytes))}. Reduce its size.`
          )
        }
        if (BigInt(total.account) > accountBytes) {
          throw new PartialUploadQuotaExceededError(
            'bytes_per_account',
            `This batch would stage ${formatBytes(Number(total.account))} for this account, above its limit of ${formatBytes(Number(accountBytes))}. Complete an upload or wait for expired uploads to be cleaned up.`,
            retryAfterOldest(total.account_oldest)
          )
        }
        if (BigInt(total.total) > globalBytes) {
          throw new PartialUploadQuotaExceededError(
            'bytes_per_server',
            `This batch would stage ${formatBytes(Number(total.total))} on the server, above its limit of ${formatBytes(Number(globalBytes))}. Retry later.`,
            retryAfterOldest(total.oldest)
          )
        }
        metrics.observe('partial_upload_reserved_bytes', {}, Number(total.total))
      },
      signal
    )
  }

  async function discardUnadmitted(entityId: string): Promise<void> {
    await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId} AND reserved_bytes = 0
      AND NOT EXISTS (SELECT 1 FROM pending_scene_files WHERE entity_id = ${entityId})`)
  }

  async function recordStored(
    entityId: string,
    hashes: string[],
    initialized: boolean,
    signal?: AbortSignal
  ): Promise<number> {
    return withUploadTransaction(
      database,
      async (query) => {
        await query(
          SQL`UPDATE pending_scene_files SET stored = true WHERE entity_id = ${entityId} AND hash = ANY(${hashes}::text[])`
        )
        const batches = await query<{ batches: number }>(SQL`UPDATE pending_scenes
          SET batches = batches + 1, initialized = initialized OR ${initialized}
          WHERE entity_id = ${entityId} RETURNING batches`)
        return batches.rows[0]?.batches ?? 0
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
    const { end } = metrics.startTimer('partial_upload_cleanup_duration_seconds')
    let outcome: 'success' | 'deferred' | 'error' = 'error'
    try {
      const removed = await sweepExpired()
      outcome = 'success'
      metrics.observe('partial_upload_cleanup_last_success_timestamp_seconds', {}, Date.now() / 1000)
      return removed
    } catch (error) {
      if (error instanceof ContentLockTimeoutError) outcome = 'deferred'
      throw error
    } finally {
      end()
      metrics.increment('partial_upload_cleanup_runs', { outcome })
      lastCleanupFinishedAt = Date.now()
    }
  }

  async function sweepExpired(): Promise<number> {
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
      metrics.increment('partial_upload_expired_uploads')
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
    const uploads = await database.query<{ live: string; expired: string }>(SQL`
      SELECT COUNT(*) FILTER (WHERE created_at >= ${new Date(Date.now() - ttlMs)})::text AS live,
        COUNT(*) FILTER (WHERE created_at < ${new Date(Date.now() - ttlMs)})::text AS expired
      FROM pending_scenes`)
    metrics.observe('partial_uploads_pending', { state: 'live' }, Number(uploads.rows[0].live))
    metrics.observe('partial_uploads_pending', { state: 'expired' }, Number(uploads.rows[0].expired))
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
    cleanupIntervalMs,
    getByEntityId,
    upsert,
    reserve,
    discardUnadmitted,
    recordStored,
    getProgress,
    markMissing,
    getCompleted,
    deleteByEntityId,
    deleteExpired,
    getActivePendingKeys
  }
}
