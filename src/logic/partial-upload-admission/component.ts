import { InvalidRequestError } from '@dcl/http-commons'
import { AppComponents } from '../../types'
import { withUploadTransaction } from '../../adapters/upload-transaction'
import { CompletedUpload, FileReceipt, PendingSceneRecord } from '../../adapters/pending-scenes-repository/types'
import { formatBytes } from '../utils'
import {
  PartialUploadExpiredError,
  PartialUploadNotFoundError,
  PartialUploadOwnershipError,
  PartialUploadQuotaExceededError,
  PartialUploadTooLargeError
} from './errors'
import { AdmitBatchInput, IPartialUploadAdmission, PendingScene, UpsertPendingScene } from './types'

/**
 * Creates the admission rules of partial uploads: the per-account upload cap, the account, server and
 * scene byte budgets, the per-minute byte rate and the fixed upload lifetime. All staging mutations run
 * under the caller's shared content lock; expired-upload cleanup is orchestrated by content GC.
 * @param components Persistence, the validated upload limits and telemetry dependencies.
 * @returns Upload lifecycle and atomic admission operations.
 */
export async function createPartialUploadAdmission(
  components: Pick<AppComponents, 'database' | 'metrics' | 'pendingScenesRepository' | 'uploadLimits'>
): Promise<IPartialUploadAdmission> {
  const { database, metrics, pendingScenesRepository: repository, uploadLimits } = components
  const ttlMs = uploadLimits.pendingDeploymentTtlMs
  const cleanupIntervalMs = uploadLimits.partialUploadCleanupIntervalMs
  const accountBytes = uploadLimits.maxPendingBytesPerDeployer
  const globalBytes = uploadLimits.maxPendingBytes
  const bytesPerMinute = uploadLimits.maxPartialUploadBytesPerMinute
  const completionTtl = uploadLimits.completedUploadTtlMs
  const maxPendingPerDeployer = uploadLimits.maxPendingDeploymentsPerDeployer

  // When this replica's cleanup last finished; the scheduled sweep runs again one interval later.
  let lastCleanupFinishedAt: number | undefined
  metrics.observe('partial_upload_capacity_bytes', {}, Number(globalBytes))

  function toPendingScene(record: PendingSceneRecord): PendingScene {
    return { ...record, expiresAt: new Date(record.createdAt.getTime() + ttlMs) }
  }

  // Capacity held by the oldest charged upload frees no earlier than its expiry; once it has expired,
  // only the next cleanup run frees it.
  function retryAfterOldest(oldestCreatedAt: Date | null): number {
    const untilExpiry = oldestCreatedAt ? oldestCreatedAt.getTime() + ttlMs - Date.now() : 0
    const untilCleanup =
      lastCleanupFinishedAt === undefined ? cleanupIntervalMs : lastCleanupFinishedAt + cleanupIntervalMs - Date.now()
    return Math.max(1, Math.ceil((untilExpiry > 0 ? untilExpiry : untilCleanup) / 1000))
  }

  async function getByEntityId(entityId: string, signal?: AbortSignal): Promise<PendingScene | undefined> {
    const record = await repository.getCreatedSince(entityId, new Date(Date.now() - ttlMs), signal)
    return record ? toPendingScene(record) : undefined
  }

  async function getCompleted(
    entityId: string,
    deployer: string,
    signal?: AbortSignal
  ): Promise<CompletedUpload | undefined> {
    return repository.getCompleted(entityId, deployer.toLowerCase(), new Date(Date.now() - completionTtl), signal)
  }

  async function upsert(input: UpsertPendingScene, signal?: AbortSignal): Promise<PendingScene> {
    const deployer = input.deployer.toLowerCase()
    return withUploadTransaction(
      database,
      async (query) => {
        await repository.lockDeployer(query, deployer)
        const existing = await repository.findRecord(query, input.entityId)
        if (existing) {
          if (existing.createdAt.getTime() < Date.now() - ttlMs) {
            throw new PartialUploadExpiredError()
          }
          // Reservations are charged to the upload's creator, so nobody else may add batches to it.
          if (existing.deployer !== deployer) {
            throw new PartialUploadOwnershipError()
          }
          return toPendingScene(existing)
        }
        // Only cleanup of an expired upload removes one seen earlier; re-creating it would restart it.
        if (input.resumes) throw new PartialUploadExpiredError()
        // A delayed first batch (slow validation or lock waits) may arrive already past its deadline.
        if (input.admittedAt.getTime() < Date.now() - ttlMs) throw new PartialUploadExpiredError()
        const { count, oldest } = await repository.countByDeployer(query, deployer)
        if (count >= maxPendingPerDeployer) {
          throw new PartialUploadQuotaExceededError(
            'uploads_per_account',
            `Too many partial uploads in progress for this account: ${count} of the ${maxPendingPerDeployer} allowed. Complete an upload or wait for expired uploads to be cleaned up.`,
            retryAfterOldest(oldest)
          )
        }
        const created = await repository.insert(query, {
          entityId: input.entityId,
          worldName: input.worldName.toLowerCase(),
          parcels: input.parcels,
          entity: input.entity,
          deployer,
          createdAt: input.admittedAt
        })
        return toPendingScene(created)
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
    const owner = await repository.getOwner(entityId, signal)
    if (!owner) throw new PartialUploadNotFoundError()
    const { deployer, createdAt } = owner
    // Nothing is charged to an upload past its deadline.
    const assertLive = (): void => {
      if (createdAt.getTime() < Date.now() - ttlMs) throw new PartialUploadExpiredError()
    }
    assertLive()
    // Committed on its own, before admission: the batch was received and processed even if it is then
    // rejected, so repeating rejected batches can't escape the rate limit.
    const rate = await repository.chargeByteRate(deployer, incomingBytes, signal)
    if (incomingBytes > bytesPerMinute) {
      throw new PartialUploadTooLargeError(
        'bytes_per_minute',
        `This batch is ${formatBytes(incomingBytes)}, above the partial upload limit of ${formatBytes(bytesPerMinute)} per minute. Send smaller batches.`
      )
    }
    if (rate.bytes > BigInt(bytesPerMinute)) {
      const retryAfter = rate.retryAfterSeconds
      throw new PartialUploadQuotaExceededError(
        'bytes_per_minute',
        `This account sent ${formatBytes(Number(rate.bytes))} of partial uploads this minute, above the limit of ${formatBytes(bytesPerMinute)} per minute. Retry in ${retryAfter} s.`,
        retryAfter
      )
    }
    await withUploadTransaction(
      database,
      async (query) => {
        // One short global admission critical section makes both aggregate budgets atomic. No storage
        // or external validation occurs under this lock. Expired reservations stay counted until cleanup.
        await repository.lockBudget(query)
        assertLive()
        // A file re-uploaded after its stored copy went missing becomes charged.
        if (receipts.length) await repository.upsertFiles(query, entityId, receipts)
        await repository.refreshReservedBytes(query, entityId)
        const total = await repository.getBudgetTotals(query, entityId, deployer)
        if (total.scene > maxSceneBytes) throw new InvalidRequestError('Deployment failed: The deployment is too big.')
        // Over a budget on its own, an upload can never be admitted; the server budget is at least this one.
        if (total.own > accountBytes) {
          throw new PartialUploadTooLargeError(
            'bytes_per_account',
            `This upload needs ${formatBytes(Number(total.own))} of staging, above the per-account partial upload limit of ${formatBytes(Number(accountBytes))}. Reduce its size.`
          )
        }
        if (total.account > accountBytes) {
          throw new PartialUploadQuotaExceededError(
            'bytes_per_account',
            `This batch would stage ${formatBytes(Number(total.account))} for this account, above its limit of ${formatBytes(Number(accountBytes))}. Complete an upload or wait for expired uploads to be cleaned up.`,
            retryAfterOldest(total.accountOldest)
          )
        }
        if (total.total > globalBytes) {
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

  async function admitBatch(input: AdmitBatchInput, signal?: AbortSignal): Promise<PendingScene> {
    const { upload, receipts, maxSceneBytes, incomingBytes } = input
    // Two transactions on purpose: the deployer lock is released before the budget lock is taken.
    const pending = await upsert(upload, signal)
    try {
      await reserve(upload.entityId, receipts, maxSceneBytes, incomingBytes, signal)
    } catch (error) {
      // A first batch that isn't admitted must not keep its new upload holding a slot of the cap.
      if (!upload.resumes) await repository.discardUnadmitted(upload.entityId).catch(() => undefined)
      throw error
    }
    return pending
  }

  async function recordStored(entityId: string, hashes: string[], signal?: AbortSignal): Promise<number> {
    return withUploadTransaction(database, (query) => repository.recordStored(query, entityId, hashes), signal)
  }

  async function markMissing(entityId: string, hashes: string[], signal?: AbortSignal): Promise<void> {
    await withUploadTransaction(database, (query) => repository.markMissing(query, entityId, hashes), signal)
  }

  async function pruneAndReport(): Promise<void> {
    await repository.pruneCompleted(new Date(Date.now() - completionTtl))
    await repository.pruneByteRates()
    const charged = await repository.getChargedBytes(new Date(Date.now() - ttlMs))
    metrics.observe('partial_upload_reserved_bytes', {}, charged.bytes)
    metrics.observe('partial_upload_cleanup_backlog_bytes', {}, charged.expired)
    const uploads = await repository.countUploads(new Date(Date.now() - ttlMs), new Date(Date.now() - ttlMs))
    metrics.observe('partial_uploads_pending', { state: 'live' }, uploads.live)
    metrics.observe('partial_uploads_pending', { state: 'expired' }, uploads.expired)
  }

  function recordCleanupFinished(): void {
    lastCleanupFinishedAt = Date.now()
  }

  return {
    getByEntityId,
    getCompleted,
    admitBatch,
    upsert,
    reserve,
    recordStored,
    markMissing,
    pruneAndReport,
    recordCleanupFinished
  }
}
