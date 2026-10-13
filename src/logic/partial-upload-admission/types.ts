import { Entity } from '@dcl/schemas'
import type { CompletedUpload, FileReceipt, PendingSceneRecord } from '../../adapters/pending-scenes-repository/types'

export type PendingScene = PendingSceneRecord & {
  /** When the upload's fixed lifetime, anchored at `createdAt`, ends. */
  expiresAt: Date
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

export type AdmitBatchInput = {
  upload: UpsertPendingScene
  /** Only charged receipts count toward the budgets; every receipt counts toward the scene size. */
  receipts: FileReceipt[]
  maxSceneBytes: bigint
  /** Bytes received in this batch, charged against the byte rate. */
  incomingBytes: number
}

export interface IPartialUploadAdmission {
  /** Retrieves a live upload without renewing its fixed expiration. */
  getByEntityId(entityId: string, signal?: AbortSignal): Promise<PendingScene | undefined>
  /** Returns a stable completion receipt only for the authenticated original deployer. */
  getCompleted(entityId: string, deployer: string, signal?: AbortSignal): Promise<CompletedUpload | undefined>
  /**
   * Creates or resumes an upload and reserves its batch: {@link IPartialUploadAdmission.upsert} under the
   * account's upload cap, then {@link IPartialUploadAdmission.reserve}. A new upload whose first batch
   * isn't admitted is discarded so it doesn't hold a slot of the cap.
   * @throws The errors of `upsert` and `reserve`.
   */
  admitBatch(input: AdmitBatchInput, signal?: AbortSignal): Promise<PendingScene>
  /**
   * Creates an independent entity upload under the account count cap; requires the shared content lock.
   * @throws PartialUploadExpiredError when the upload is gone or its lifetime from `admittedAt` has ended.
   * @throws PartialUploadOwnershipError when another account started the upload.
   * @throws PartialUploadQuotaExceededError when the account has its maximum of uploads.
   */
  upsert(input: UpsertPendingScene, signal?: AbortSignal): Promise<PendingScene>
  /**
   * Reserves bytes before writes, including concurrent account/global budgets and incoming byte rate.
   * Only charged receipts count toward the budgets; every receipt counts toward the scene size.
   * @throws PartialUploadNotFoundError when the upload no longer exists.
   * @throws PartialUploadExpiredError when the upload has expired; nothing is charged then.
   * @throws PartialUploadTooLargeError when the batch or the upload alone exceeds a budget.
   * @throws PartialUploadQuotaExceededError when other uploads or traffic fill a budget for now.
   * @throws InvalidRequestError when the scene exceeds `maxSceneBytes`.
   */
  reserve(
    entityId: string,
    receipts: FileReceipt[],
    maxSceneBytes: bigint,
    incomingBytes: number,
    signal?: AbortSignal
  ): Promise<void>
  /**
   * Records successful writes, counts the batch and marks the initial stored-content inventory as
   * complete. Returns the upload's stored batches so far.
   */
  recordStored(entityId: string, hashes: string[], signal?: AbortSignal): Promise<number>
  /** Prunes completion receipts and rate windows and refreshes the gauges. */
  pruneAndReport(): Promise<void>
  /** Records that a cleanup run finished; quota Retry-After estimates the next run from it. */
  recordCleanupFinished(): void
}
