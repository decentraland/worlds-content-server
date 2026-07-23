import { Entity } from '@dcl/schemas'

/**
 * A partial (multi-request) deployment being staged. Content is uploaded across several requests and
 * the entity only becomes a live world_scenes row once every referenced file is present. Stored in a
 * standalone `pending_scenes` table (no FK to `worlds`, so a half-uploaded world never leaks into
 * listings). The authoritative entity *bytes* live in content storage under the entity id.
 */
export type PendingScene = {
  entityId: string
  worldName: string
  parcels: string[]
  deployer: string
  createdAt: Date
  updatedAt: Date
}

export type UpsertPendingScene = {
  entityId: string
  worldName: string
  parcels: string[]
  entity: Entity
  deployer: string
}

export type IPendingScenesManager = {
  /** Returns the pending scene for an entity id, treating rows past the TTL as absent. */
  getByEntityId(entityId: string): Promise<PendingScene | undefined>
  /**
   * Records/refreshes a pending scene, replacing any non-expired pending scene of the same world whose
   * parcels overlap (enforces "at most one pending upload per world+parcel"), but only when the incoming
   * scene is newer (deployment ordering) than the overlapping ones — a strictly-newer overlapping upload
   * causes a rejection instead. On conflict of the same entity id it only bumps updated_at so created_at
   * (the TTL anchor) stays stable across resumes.
   *
   * The per-deployer concurrent-pending cap (`limit.maxPendingPerDeployer`) is enforced inside the same
   * transaction under a per-deployer lock, and only when the upsert would create a NEW row — a resume of
   * an existing upload is always allowed through, so lowering the cap can never wedge in-flight uploads.
   * @throws InvalidRequestError if a strictly-newer overlapping pending upload is already in progress,
   *   or if creating this new pending upload would put the deployer over the per-deployer cap.
   */
  upsert(input: UpsertPendingScene, limit: { maxPendingPerDeployer: number }): Promise<PendingScene>
  deleteByEntityId(entityId: string): Promise<void>
  /** Deletes pending scenes older than the configured PENDING_DEPLOYMENT_TTL. Returns the number removed. */
  deleteExpired(): Promise<number>
  /**
   * Returns the storage keys referenced by every non-expired pending scene: each entity id, its
   * `.auth` blob, and its content-file hashes. Used by garbage collection to protect in-flight uploads.
   */
  getActivePendingKeys(): Promise<Set<string>>
}
