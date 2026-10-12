const MB = 1024 * 1024

/**
 * Coarse limits applied while parsing multipart bodies. They comfortably fit a legitimate
 * world deployment while bounding how much an (unauthenticated) request can buffer in memory,
 * since the parser runs before any signature/size validation. Precise per-world size limits
 * are still enforced afterwards by the deployment validator.
 */
export const DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES = 350 * MB
/** Default concurrent uploads in flight per source. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SOURCE = 4
/** Default per-scene size cap for DCL-name worlds, in MiB. */
export const DEFAULT_MAX_SCENE_SIZE_MB = 500
/** Default lifetime of a pending (partial) upload, anchored at its first request. */
export const DEFAULT_PENDING_DEPLOYMENT_TTL_MS = 60 * 60 * 1000
/** Default interval between expired-upload cleanup runs. */
export const DEFAULT_PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
/** Default staged/reserved bytes per deployer. */
export const DEFAULT_MAX_PENDING_BYTES_PER_DEPLOYER = 1024 ** 3
/** Default staged/reserved bytes across the server. */
export const DEFAULT_MAX_PENDING_BYTES = 50 * 1024 ** 3
/** Default partial-upload bytes a deployer may send per minute. */
export const DEFAULT_MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE = 512 * 1024 ** 2
/** Default lifetime of a completed upload's receipt. */
export const DEFAULT_COMPLETED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
/** Default partial uploads in progress per deployer. */
export const DEFAULT_MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER = 10

/**
 * Default aggregate bytes in flight (written to temp files) across all concurrent multipart uploads.
 * The parser on POST /entities runs before any authentication, so without this ceiling an
 * unauthenticated client could open many concurrent uploads and exhaust resources.
 *
 * Uploads are streamed to disk rather than buffered in memory, so the limiting resource is the
 * container's ephemeral storage (e.g. 20 GB by default on Fargate), not RAM. Tune it to the
 * available disk via the MAX_IN_FLIGHT_UPLOAD_BYTES config. Requests grow their reservations from
 * parsed payload bytes as they arrive, so multipart framing is never charged against the budget.
 *
 * The same budget also bounds concurrency and temporary files: every request reserves at least
 * {@link DEFAULT_MIN_UPLOAD_RESERVATION_BYTES} (budget / 16 MiB concurrent small requests) and
 * every file part adds {@link DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES} (budget / 16 KiB files).
 */
export const DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES = 4 * 1024 * MB
/** Per-request overhead charged even for tiny bodies: fields in memory, parser buffers, temp dir, socket. */
export const DEFAULT_MIN_UPLOAD_RESERVATION_BYTES = 16 * MB
/** Per-file overhead charged on top of its bytes: inode, block rounding, descriptor. */
export const DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES = 16 * 1024
/** Default failed-cleanup upload directories tolerated before admission stops. */
export const DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES = 40
/** Default time allowed to receive and parse a multipart body. */
export const DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000
