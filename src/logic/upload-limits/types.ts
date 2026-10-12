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
}
