/** Upload size, quota and lifetime settings, read and cross-checked once at startup. */
export type UploadLimits = {
  /** MAX_CONCURRENT_UPLOADS_PER_SOURCE. */
  maxConcurrentUploadsPerSource: number
  /** MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE; fits at least one maximum-size upload. */
  maxInFlightUploadBytesPerSource: number
  /** MAX_SCENE_SIZE, in bytes. */
  maxSceneSizeInBytes: bigint
  /** MAX_PENDING_BYTES_PER_DEPLOYER; at least the scene size cap. */
  maxPendingBytesPerDeployer: bigint
  /** MAX_PENDING_BYTES; at least the per-deployer budget. */
  maxPendingBytes: bigint
  /** MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE; fits at least one maximum-size upload. */
  maxPartialUploadBytesPerMinute: number
  /** PENDING_DEPLOYMENT_TTL: the fixed pending upload lifetime. */
  pendingDeploymentTtlMs: number
  /** PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS: how often expired uploads are cleaned up. */
  partialUploadCleanupIntervalMs: number
  /** COMPLETED_UPLOAD_TTL: how long a completed upload's receipt is kept. */
  completedUploadTtlMs: number
  /** MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER. */
  maxPendingDeploymentsPerDeployer: number
  /** PENDING_BYTES_PER_WORLD_FACTOR: a world's staging budget in multiples of its per-scene size cap. */
  pendingBytesPerWorldFactor: number
  /** MAX_PENDING_DEPLOYMENTS_PER_WORLD: live uploads per world across every deployer. */
  maxPendingDeploymentsPerWorld: number
  /** MAX_IN_FLIGHT_UPLOAD_BYTES: aggregate multipart bytes in flight; at least the per-request minimum. */
  maxInFlightUploadBytes: number
  /** MIN_UPLOAD_RESERVATION_BYTES: bytes every admitted multipart request reserves. */
  minUploadReservationBytes: number
  /** UPLOAD_FILE_OVERHEAD_BYTES: bytes charged per uploaded file on top of its payload. */
  uploadFileOverheadBytes: number
  /** MAX_ORPHANED_UPLOAD_DIRECTORIES: failed-cleanup directories tolerated before admission stops. */
  maxOrphanedUploadDirectories: number
  /** MULTIPART_UPLOAD_TIMEOUT_MS: time allowed to receive and parse a multipart body. */
  multipartUploadTimeoutMs: number
}
