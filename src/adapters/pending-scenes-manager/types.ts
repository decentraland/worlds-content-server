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
}

export type FileReceipt = { hash: string; size: number; stored: boolean }
export type CompletedUpload = { worldName: string; parcels: string[]; creationTimestamp: number }

export interface IPendingScenesManager extends IBaseComponent {
  /** Retrieves a live upload without renewing its fixed expiration. */
  getByEntityId(entityId: string, signal?: AbortSignal): Promise<PendingScene | undefined>
  /** Creates an independent entity upload under the account count cap; requires the shared content lock. */
  upsert(
    input: UpsertPendingScene,
    limit: { maxPendingPerDeployer: number },
    signal?: AbortSignal
  ): Promise<PendingScene>
  /** Reserves bytes before writes, including concurrent account/global budgets and incoming byte rate. */
  reserve(
    entityId: string,
    receipts: FileReceipt[],
    maxSceneBytes: bigint,
    incomingBytes: number,
    signal?: AbortSignal
  ): Promise<void>
  /** Removes an upload whose first batch was never admitted, so it doesn't hold a slot of its deployer's cap. */
  discardUnadmitted(entityId: string): Promise<void>
  /** Records successful writes; initialized means the initial stored-content inventory is complete. */
  recordStored(entityId: string, hashes: string[], initialized: boolean, signal?: AbortSignal): Promise<void>
  /** Returns successfully stored file sizes, never treating reservations as completed writes. */
  getProgress(entityId: string, signal?: AbortSignal): Promise<Map<string, number>>
  /** Forgets receipts invalidated by a final storage verification. Reservations remain charged. */
  markMissing(entityId: string, hashes: string[], signal?: AbortSignal): Promise<void>
  /** Returns a stable completion receipt only for the authenticated original deployer. */
  getCompleted(entityId: string, deployer: string, signal?: AbortSignal): Promise<CompletedUpload | undefined>
  /** Removes staging state only after successful publication (normal publication does this atomically). */
  deleteByEntityId(entityId: string): Promise<void>
  /** Reclaims expired content under the exclusive lock before releasing its byte accounting. */
  deleteExpired(): Promise<number>
  /** Returns non-expired staging references for compatibility with existing callers. */
  getActivePendingKeys(): Promise<Set<string>>
  /** The fixed pending upload lifetime used by GC. */
  readonly ttlMs: number
}
