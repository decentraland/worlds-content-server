import { Entity } from '@dcl/schemas'
import { IBaseComponent } from '@well-known-components/interfaces'

export type PendingScene = {
  entityId: string
  worldName: string
  parcels: string[]
  deployer: string
  createdAt: Date
  updatedAt: Date
  initialized: boolean
}

export type UpsertPendingScene = {
  entityId: string
  worldName: string
  parcels: string[]
  entity: Entity
  deployer: string
  /** Admission instant: anchors both the entity freshness check and the fixed upload lifetime. */
  admittedAt: Date
  /** Whether the caller already saw this upload live; if it is gone by now, it expired. */
  resumes: boolean
}

/**
 * `charged`: the bytes count toward the staging budgets. Only content already referenced by published
 * content is free; content held only by pending uploads is charged even though it isn't stored again.
 */
export type FileReceipt = { hash: string; size: number; stored: boolean; charged: boolean }
type CompletedUpload = { worldName: string; parcels: string[]; creationTimestamp: number }

/**
 * Result of an expired-upload cleanup run. `success`: every visited upload was reclaimed; `deferred`:
 * uploads kept the content lock busy so the run stopped early; `error`: some upload failed (logged), even
 * if the run was then deferred.
 */
export type ExpiredUploadsCleanup = { outcome: 'success' | 'deferred' | 'error'; removed: number; failed: number }

export interface IPendingScenesManager extends IBaseComponent {
  /** Retrieves a live upload without renewing its fixed expiration. */
  getByEntityId(entityId: string, signal?: AbortSignal): Promise<PendingScene | undefined>
  /**
   * Returns the given hashes referenced by published content (world scenes, including soft-deleted ones
   * awaiting eviction, or world thumbnails). References from pending uploads don't count.
   */
  getPublishedContent(hashes: string[], signal?: AbortSignal): Promise<Set<string>>
  /**
   * Creates an independent entity upload under the account count cap; requires the shared content lock.
   * @throws PartialUploadExpiredError when the upload is gone or its lifetime from `admittedAt` has ended.
   */
  upsert(
    input: UpsertPendingScene,
    limit: { maxPendingPerDeployer: number },
    signal?: AbortSignal
  ): Promise<PendingScene>
  /**
   * Reserves bytes before writes, including concurrent account/global budgets and incoming byte rate.
   * Only charged receipts count toward the budgets; every receipt counts toward the scene size.
   * @throws PartialUploadExpiredError when the upload has expired; nothing is charged then.
   * @throws PartialUploadTooLargeError when the batch or the upload alone exceeds a budget.
   * @throws PartialUploadQuotaExceededError when other uploads or traffic fill a budget for now.
   */
  reserve(
    entityId: string,
    receipts: FileReceipt[],
    maxSceneBytes: bigint,
    incomingBytes: number,
    signal?: AbortSignal
  ): Promise<void>
  /** Removes an upload whose first batch was never admitted, so it doesn't hold a slot of its deployer's cap. */
  discardUnadmitted(entityId: string): Promise<void>
  /**
   * Records successful writes and counts the batch; initialized means the initial stored-content
   * inventory is complete. Returns the upload's stored batches so far.
   */
  recordStored(entityId: string, hashes: string[], initialized: boolean, signal?: AbortSignal): Promise<number>
  /** Returns successfully stored file sizes, never treating reservations as completed writes. */
  getProgress(entityId: string, signal?: AbortSignal): Promise<Map<string, number>>
  /** Forgets receipts invalidated by a final storage verification. Reservations remain charged. */
  markMissing(entityId: string, hashes: string[], signal?: AbortSignal): Promise<void>
  /** Returns a stable completion receipt only for the authenticated original deployer. */
  getCompleted(entityId: string, deployer: string, signal?: AbortSignal): Promise<CompletedUpload | undefined>
  /** Removes staging state only after successful publication (normal publication does this atomically). */
  deleteByEntityId(entityId: string): Promise<void>
  /**
   * Reclaims expired content under the exclusive lock before releasing its byte accounting, then prunes
   * completion receipts and rate windows and refreshes the gauges. Visits every upload expired when the
   * run starts; a failing upload doesn't stop the run. Concurrent calls run one after another.
   * @throws Error only when pruning or reporting fails.
   */
  deleteExpired(): Promise<ExpiredUploadsCleanup>
  /** The fixed pending upload lifetime used by GC. */
  readonly ttlMs: number
  /** How often the scheduled job runs {@link IPendingScenesManager.deleteExpired}. */
  readonly cleanupIntervalMs: number
}
