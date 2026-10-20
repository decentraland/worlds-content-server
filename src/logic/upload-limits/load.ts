import { IConfigComponent } from '@well-known-components/interfaces'
import { getPositiveInteger } from '../concurrency'
import { MB_BigInt } from '../../types'
import {
  DEFAULT_COMPLETED_UPLOAD_TTL_MS,
  DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SOURCE,
  DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES,
  DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES,
  DEFAULT_MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE,
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_PENDING_BYTES_PER_DEPLOYER,
  DEFAULT_MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER,
  DEFAULT_MAX_PENDING_DEPLOYMENTS_PER_WORLD,
  DEFAULT_MAX_SCENE_SIZE_MB,
  DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES,
  DEFAULT_MIN_UPLOAD_RESERVATION_BYTES,
  DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS,
  DEFAULT_PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_PENDING_BYTES_PER_WORLD_FACTOR,
  DEFAULT_PENDING_DEPLOYMENT_TTL_MS,
  DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES
} from './constants'
import { UploadLimits } from './types'
import { validatePositiveByteLimit, validateReservationBytes } from './validation'

/**
 * Reads every upload size, quota and lifetime setting and checks the invariants between them.
 * @param config Configuration.
 * @returns The validated limits.
 * @throws Error when a setting isn't a positive safe integer or the settings contradict each other.
 */
export async function loadUploadLimits(config: Pick<IConfigComponent, 'getNumber'>): Promise<UploadLimits> {
  const maxConcurrentUploadsPerSource = await getPositiveInteger(
    config,
    'MAX_CONCURRENT_UPLOADS_PER_SOURCE',
    DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SOURCE
  )
  const maxInFlightUploadBytesPerSource = await getPositiveInteger(
    config,
    'MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE',
    DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  )
  if (maxInFlightUploadBytesPerSource < DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES) {
    throw new Error(
      `MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE (${maxInFlightUploadBytesPerSource}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
    )
  }

  const maxSceneSizeInBytes =
    BigInt(await getPositiveInteger(config, 'MAX_SCENE_SIZE', DEFAULT_MAX_SCENE_SIZE_MB)) * MB_BigInt
  const maxPendingBytesPerDeployer = BigInt(
    await getPositiveInteger(config, 'MAX_PENDING_BYTES_PER_DEPLOYER', DEFAULT_MAX_PENDING_BYTES_PER_DEPLOYER)
  )
  // A capped scene uploaded in batches must always fit the deployer's staging budget.
  if (maxPendingBytesPerDeployer < maxSceneSizeInBytes) {
    throw new Error(
      `MAX_PENDING_BYTES_PER_DEPLOYER (${maxPendingBytesPerDeployer}) must be at least MAX_SCENE_SIZE (${maxSceneSizeInBytes} bytes).`
    )
  }

  const pendingDeploymentTtlMs = await getPositiveInteger(
    config,
    'PENDING_DEPLOYMENT_TTL',
    DEFAULT_PENDING_DEPLOYMENT_TTL_MS
  )
  const partialUploadCleanupIntervalMs = await getPositiveInteger(
    config,
    'PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS',
    DEFAULT_PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS
  )
  const maxPendingBytes = BigInt(await getPositiveInteger(config, 'MAX_PENDING_BYTES', DEFAULT_MAX_PENDING_BYTES))
  const maxPartialUploadBytesPerMinute = await getPositiveInteger(
    config,
    'MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE',
    DEFAULT_MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE
  )
  const completedUploadTtlMs = await getPositiveInteger(config, 'COMPLETED_UPLOAD_TTL', DEFAULT_COMPLETED_UPLOAD_TTL_MS)
  // Otherwise a valid request or upload could be rejected by its own size forever.
  if (maxPartialUploadBytesPerMinute < DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES) {
    throw new Error(
      `MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE (${maxPartialUploadBytesPerMinute}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
    )
  }
  if (maxPendingBytes < maxPendingBytesPerDeployer) {
    throw new Error(
      `MAX_PENDING_BYTES (${maxPendingBytes}) must be at least MAX_PENDING_BYTES_PER_DEPLOYER (${maxPendingBytesPerDeployer}).`
    )
  }

  const maxPendingDeploymentsPerDeployer = await getPositiveInteger(
    config,
    'MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER',
    DEFAULT_MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER
  )
  const pendingBytesPerWorldFactor = await getPositiveInteger(
    config,
    'PENDING_BYTES_PER_WORLD_FACTOR',
    DEFAULT_PENDING_BYTES_PER_WORLD_FACTOR
  )
  const maxPendingDeploymentsPerWorld = await getPositiveInteger(
    config,
    'MAX_PENDING_DEPLOYMENTS_PER_WORLD',
    DEFAULT_MAX_PENDING_DEPLOYMENTS_PER_WORLD
  )

  // Multipart in-flight budget; errors keep the parser's setting names.
  const maxInFlightUploadBytes =
    (await config.getNumber('MAX_IN_FLIGHT_UPLOAD_BYTES')) ?? DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES
  const minUploadReservationBytes =
    (await config.getNumber('MIN_UPLOAD_RESERVATION_BYTES')) ?? DEFAULT_MIN_UPLOAD_RESERVATION_BYTES
  const uploadFileOverheadBytes =
    (await config.getNumber('UPLOAD_FILE_OVERHEAD_BYTES')) ?? DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES
  const maxOrphanedUploadDirectories =
    (await config.getNumber('MAX_ORPHANED_UPLOAD_DIRECTORIES')) ?? DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES
  const multipartUploadTimeoutMs =
    (await config.getNumber('MULTIPART_UPLOAD_TIMEOUT_MS')) ?? DEFAULT_MULTIPART_UPLOAD_TIMEOUT_MS
  validatePositiveByteLimit('maxInFlightUploadBytes', maxInFlightUploadBytes)
  validateReservationBytes('minUploadReservationBytes', minUploadReservationBytes)
  validateReservationBytes('uploadFileOverheadBytes', uploadFileOverheadBytes)
  validatePositiveByteLimit('maxOrphanedUploadDirectories', maxOrphanedUploadDirectories)
  if (maxInFlightUploadBytes < minUploadReservationBytes) {
    throw new Error(
      `maxInFlightUploadBytes (${maxInFlightUploadBytes}) must be greater than or equal to minUploadReservationBytes (${minUploadReservationBytes})`
    )
  }
  validatePositiveByteLimit('uploadTimeoutMs', multipartUploadTimeoutMs)

  return {
    maxConcurrentUploadsPerSource,
    maxInFlightUploadBytesPerSource,
    maxSceneSizeInBytes,
    maxPendingBytesPerDeployer,
    maxPendingBytes,
    maxPartialUploadBytesPerMinute,
    pendingDeploymentTtlMs,
    partialUploadCleanupIntervalMs,
    completedUploadTtlMs,
    maxPendingDeploymentsPerDeployer,
    pendingBytesPerWorldFactor,
    maxPendingDeploymentsPerWorld,
    maxInFlightUploadBytes,
    minUploadReservationBytes,
    uploadFileOverheadBytes,
    maxOrphanedUploadDirectories,
    multipartUploadTimeoutMs
  }
}
