/**
 * Result of an expired-upload cleanup run. `success`: every visited upload was reclaimed; `deferred`:
 * uploads kept the content lock busy so the run stopped early; `error`: some upload failed (logged), even
 * if the run was then deferred.
 */
export type ExpiredUploadsCleanup = { outcome: 'success' | 'deferred' | 'error'; removed: number; failed: number }

/** Result of a full garbage collection: unreferenced keys removed, then the expired-upload cleanup. */
export type GarbageCollection = { removed: number; expiredUploads: ExpiredUploadsCleanup }

export interface IContentGcComponent {
  /**
   * Deletes the given keys no content references, in batches, each under the exclusive content lock.
   * Content held by live pending uploads counts as referenced.
   * @returns How many keys were deleted.
   * @throws ContentLockTimeoutError when uploads keep the content lock busy.
   */
  deleteUnreferenced(keys: string[]): Promise<number>
  /**
   * Scans storage deleting unreferenced keys, then runs the expired-upload cleanup. The cleanup's
   * deferral or failures don't fail the sweep; they are reported in its result.
   * @throws ContentLockTimeoutError when uploads keep the content lock busy during the sweep.
   */
  collectGarbage(): Promise<GarbageCollection>
  /**
   * Reclaims each expired upload's unreferenced objects before releasing its byte accounting, then
   * prunes completion receipts and rate windows and refreshes the gauges. Visits every upload expired
   * when the run starts; a failing upload doesn't stop the run. Concurrent calls run one after another.
   * @throws Error only when pruning or reporting fails.
   */
  deleteExpiredUploads(): Promise<ExpiredUploadsCleanup>
}
