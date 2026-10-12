import { Entity } from '@dcl/schemas'
import { IBaseComponent } from '@well-known-components/interfaces'
import { Query } from '../upload-transaction'

/** A stored pending upload, as persisted. */
export type PendingSceneRecord = {
  entityId: string
  worldName: string
  parcels: string[]
  deployer: string
  createdAt: Date
  updatedAt: Date
  initialized: boolean
}

export type NewPendingScene = {
  entityId: string
  worldName: string
  parcels: string[]
  entity: Entity
  deployer: string
  createdAt: Date
}

/**
 * `charged`: the bytes count toward the staging budgets. Only content already referenced by published
 * content is free; content held only by pending uploads is charged even though it isn't stored again.
 */
export type FileReceipt = { hash: string; size: number; stored: boolean; charged: boolean }
export type CompletedUpload = { worldName: string; parcels: string[]; creationTimestamp: number }

/** A publication of an entity, recorded inside its publication transaction. */
export type PublicationRecord = {
  entityId: string
  deployer: string
  worldName: string
  parcels: string[]
  publishedAt: Date
  /** Whether the publication finalizes a partial upload, which earns its deployer a completion receipt. */
  completesPartialUpload: boolean
}

/** An expired upload's keyset position; `createdAt` travels as text to keep its microseconds. */
export type ExpiredUploadCursor = { entityId: string; createdAt: string }

/** The per-minute byte window of an account after charging a batch. */
export type ByteRateWindow = { bytes: bigint; retryAfterSeconds: number }

/** Staged bytes as seen by an upload's reservation. */
export type BudgetTotals = {
  /** Charged bytes of the account's uploads. */
  account: bigint
  /** Charged bytes of every upload. */
  total: bigint
  /** Charged bytes of this upload. */
  own: bigint
  /** Every known file of this upload but its entity file, charged or not. */
  scene: bigint
  /** Creation of the account's oldest upload holding charged bytes. */
  accountOldest: Date | null
  /** Creation of the oldest upload holding charged bytes. */
  oldest: Date | null
}

/**
 * SQL over the pending upload tables. Methods taking a `query` run inside the caller's transaction;
 * the others run standalone on the pool.
 */
export interface IPendingScenesRepository extends IBaseComponent {
  /** Retrieves an upload still live at `cutoff` (`now - ttl`): created after it. */
  getCreatedSince(entityId: string, cutoff: Date, signal?: AbortSignal): Promise<PendingSceneRecord | undefined>
  /**
   * Returns the given hashes referenced by published content (world scenes, including soft-deleted ones
   * awaiting eviction, or world thumbnails). References from pending uploads don't count.
   */
  getPublishedContent(hashes: string[], signal?: AbortSignal): Promise<Set<string>>
  /**
   * Returns the given keys referenced by any content, in one snapshot: world scenes (including soft-deleted
   * ones awaiting eviction), world thumbnails and uploads created after `pendingCutoff`. Call under the
   * exclusive content lock before deleting them.
   */
  getReferencedContentKeys(pendingCutoff: Date, candidates: string[]): Promise<Set<string>>
  /** Serializes the transaction with every other one holding the same deployer's lock. */
  lockDeployer(query: Query, deployer: string): Promise<void>
  /** Retrieves an upload whatever its age. */
  findRecord(query: Query, entityId: string): Promise<PendingSceneRecord | undefined>
  /** Counts a deployer's uploads and finds the oldest one's creation. */
  countByDeployer(query: Query, deployer: string): Promise<{ count: number; oldest: Date | null }>
  insert(query: Query, scene: NewPendingScene): Promise<PendingSceneRecord>
  /** Retrieves who owns an upload and when it was created. */
  getOwner(entityId: string, signal?: AbortSignal): Promise<{ deployer: string; createdAt: Date } | undefined>
  /** Adds bytes to the deployer's current one-minute window, starting a new window once it is over. */
  chargeByteRate(deployer: string, bytes: number, signal?: AbortSignal): Promise<ByteRateWindow>
  /** Serializes the transaction with every other budget reservation. */
  lockBudget(query: Query): Promise<void>
  /** Merges receipts into the upload's files; a file's size, stored and charged flags only grow. */
  upsertFiles(query: Query, entityId: string, receipts: FileReceipt[]): Promise<void>
  /** Recomputes the upload's reserved bytes from its charged files. */
  refreshReservedBytes(query: Query, entityId: string): Promise<void>
  getBudgetTotals(query: Query, entityId: string, deployer: string): Promise<BudgetTotals>
  /** Removes an upload holding no reservation nor files. */
  discardUnadmitted(entityId: string): Promise<void>
  /** Marks files as stored and counts a batch. Returns the upload's batches so far, 0 when it is gone. */
  recordStored(query: Query, entityId: string, hashes: string[]): Promise<number>
  /** Returns stored file sizes by hash. */
  getProgress(entityId: string, signal?: AbortSignal): Promise<Map<string, number>>
  /** Marks files as not stored. */
  markMissing(query: Query, entityId: string, hashes: string[]): Promise<void>
  /** Returns the deployer's completion receipt completed at or after `completedSince`. */
  getCompleted(
    entityId: string,
    deployer: string,
    completedSince: Date,
    signal?: AbortSignal
  ): Promise<CompletedUpload | undefined>
  /**
   * Creates or replaces the entity's completion receipt when the publication finalizes a partial upload,
   * drops it otherwise, then deletes the entity's pending upload.
   * @returns Whether a pending upload was deleted.
   */
  recordPublication(query: Query, publication: PublicationRecord): Promise<{ consumed: boolean }>
  /** Removes an upload only once its entity is published. */
  deleteByEntityId(entityId: string): Promise<void>
  /**
   * Lists uploads created at or before `cutoff`, oldest first, resuming after `after`.
   * @param limit Maximum uploads returned; a shorter page means no more remain.
   */
  listExpired(cutoff: Date, after: ExpiredUploadCursor | undefined, limit: number): Promise<ExpiredUploadCursor[]>
  /** Returns every storage key an upload may have staged: its files, entity and auth chain. */
  getUploadKeys(entityId: string): Promise<string[]>
  /** Releases an upload's accounting if it was created at or before `cutoff`. */
  releaseExpired(entityId: string, cutoff: Date): Promise<void>
  /** Deletes completion receipts completed before `before`. */
  pruneCompleted(before: Date): Promise<void>
  /** Deletes byte-rate windows older than a minute. */
  pruneByteRates(): Promise<void>
  /** Sums charged bytes, in total and of expired uploads (created at or before `cutoff`). */
  getChargedBytes(cutoff: Date): Promise<{ bytes: number; expired: number }>
  /** Counts live uploads (created after `cutoff`) and expired ones (at or before it). */
  countUploads(cutoff: Date): Promise<{ live: number; expired: number }>
}
