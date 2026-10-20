import { AppComponents } from '../../types'
import {
  DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES,
  DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES,
  DEFAULT_MIN_UPLOAD_RESERVATION_BYTES,
  DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES,
  validatePositiveByteLimit,
  validateReservationBytes
} from '../../logic/upload-limits'
import { notifySafely } from '../../logic/utils'
import {
  IInFlightUploadBudget,
  InFlightUploadBudgetOptions,
  InFlightUploadBudgetSnapshot,
  InFlightUploadReleaseOptions
} from './types'

/**
 * Creates the process-wide multipart upload budget from the upload limits and reports its state as
 * metrics. All multipart routes must share it.
 * @param components The validated upload limits and the metrics its state is reported to.
 * @returns The shared upload budget.
 */
export async function createInFlightUploadBudget(
  components: Pick<AppComponents, 'metrics' | 'uploadLimits'>
): Promise<IInFlightUploadBudget> {
  const { metrics, uploadLimits } = components
  const onStateChange = ({
    reservedBytes,
    orphanedBytes,
    reservedFiles,
    orphanedFiles,
    orphanedDirectories,
    activeUploads
  }: InFlightUploadBudgetSnapshot): void => {
    metrics.observe('multipart_upload_reserved_bytes', {}, reservedBytes)
    metrics.observe('multipart_upload_orphaned_bytes', {}, orphanedBytes)
    metrics.observe('multipart_upload_reserved_files', {}, reservedFiles)
    metrics.observe('multipart_upload_orphaned_files', {}, orphanedFiles)
    metrics.observe('multipart_upload_orphaned_directories', {}, orphanedDirectories)
    metrics.observe('multipart_upload_active', {}, activeUploads)
  }
  const budget = buildInFlightUploadBudget(uploadLimits.maxInFlightUploadBytes, {
    minUploadReservationBytes: uploadLimits.minUploadReservationBytes,
    uploadFileOverheadBytes: uploadLimits.uploadFileOverheadBytes,
    maxOrphanedUploadDirectories: uploadLimits.maxOrphanedUploadDirectories,
    onStateChange
  })
  metrics.observe('multipart_upload_capacity_bytes', {}, budget.snapshot().capacity)
  return budget
}

/**
 * Builds a byte budget shared by every multipart route that receives the returned object.
 *
 * Each admitted request charges max(minUploadReservationBytes, payload + files × uploadFileOverheadBytes),
 * so the one byte capacity bounds disk bytes, concurrent requests and temporary files together.
 *
 * @param capacity Maximum number of bytes that may be charged concurrently.
 * @param options Per-request and per-file charges, orphan-directory limit and state observer.
 * @returns A synchronous reservation and rejected-body drain tracker for multipart requests.
 */
export function buildInFlightUploadBudget(
  capacity: number = DEFAULT_MAX_IN_FLIGHT_UPLOAD_BYTES,
  options: InFlightUploadBudgetOptions = {}
): IInFlightUploadBudget {
  const {
    minUploadReservationBytes = DEFAULT_MIN_UPLOAD_RESERVATION_BYTES,
    uploadFileOverheadBytes = DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES,
    maxOrphanedUploadDirectories = DEFAULT_MAX_ORPHANED_UPLOAD_DIRECTORIES,
    onStateChange
  } = options
  validatePositiveByteLimit('maxInFlightUploadBytes', capacity)
  validateReservationBytes('minUploadReservationBytes', minUploadReservationBytes)
  validateReservationBytes('uploadFileOverheadBytes', uploadFileOverheadBytes)
  validatePositiveByteLimit('maxOrphanedUploadDirectories', maxOrphanedUploadDirectories)
  if (capacity < minUploadReservationBytes) {
    throw new Error(
      `maxInFlightUploadBytes (${capacity}) must be greater than or equal to minUploadReservationBytes (${minUploadReservationBytes})`
    )
  }
  // Rejected bodies are drained without disk, but still hold a socket each: cap them like small uploads.
  const maxConcurrentUploads = Math.floor(capacity / Math.max(minUploadReservationBytes, 1))
  const charge = (payloadBytes: number, files: number): number =>
    Math.max(minUploadReservationBytes, payloadBytes + files * uploadFileOverheadBytes)
  let reservedBytes = 0
  let orphanedBytes = 0
  let reservedFiles = 0
  let orphanedFiles = 0
  let orphanedDirectories = 0
  let activeUploads = 0
  let activeRejectedBodyDrains = 0

  const snapshot = (): InFlightUploadBudgetSnapshot => ({
    capacity,
    reservedBytes,
    orphanedBytes,
    reservedFiles,
    orphanedFiles,
    orphanedDirectories,
    activeUploads,
    maxConcurrentUploads,
    minUploadReservationBytes,
    uploadFileOverheadBytes,
    maxOrphanedUploadDirectories
  })
  const emitState = (): void => notifySafely(onStateChange, snapshot())

  return {
    capacity,
    uploadFileOverheadBytes,
    snapshot,
    tryAcquireRejectedBodyDrain(): (() => void) | undefined {
      if (activeRejectedBodyDrains >= maxConcurrentUploads) {
        return undefined
      }
      activeRejectedBodyDrains++
      let released = false
      return () => {
        if (!released) {
          released = true
          activeRejectedBodyDrains--
        }
      }
    },
    acquire(bytes: number) {
      validateReservationBytes('upload reservation', bytes)
      if (orphanedDirectories >= maxOrphanedUploadDirectories) {
        return { rejectionReason: 'storage' as const }
      }
      const initialCharge = charge(bytes, 0)
      if (reservedBytes + initialCharge > capacity) {
        return { rejectionReason: 'bytes' as const }
      }
      reservedBytes += initialCharge
      activeUploads++
      emitState()
      let leaseBytes = bytes
      let leaseFiles = 0
      let leaseCharge = initialCharge
      let released = false
      let retainedCharge = 0
      let retainedFiles = 0
      let retainedDirectory = false

      const recharge = (nextBytes: number, nextFiles: number): boolean => {
        const nextCharge = charge(nextBytes, nextFiles)
        if (released || reservedBytes - leaseCharge + nextCharge > capacity) {
          return false
        }
        reservedBytes += nextCharge - leaseCharge
        reservedFiles += nextFiles - leaseFiles
        leaseBytes = nextBytes
        leaseFiles = nextFiles
        leaseCharge = nextCharge
        emitState()
        return true
      }

      return {
        lease: {
          getPayloadBytes: () => leaseBytes,
          getReservedFiles: () => leaseFiles,
          getChargedBytes: () => leaseCharge,
          resize(nextBytes: number): boolean {
            validateReservationBytes('upload reservation', nextBytes)
            return recharge(nextBytes, leaseFiles)
          },
          resizeFiles(nextFiles: number): boolean {
            validateReservationBytes('upload file reservation', nextFiles)
            return recharge(leaseBytes, nextFiles)
          },
          release(options?: InFlightUploadReleaseOptions): void {
            if (!released) {
              const nextRetainedBytes = options?.retainBytes ?? 0
              const nextRetainedFiles = options?.retainFiles ?? 0
              validateReservationBytes('retained upload bytes', nextRetainedBytes)
              validateReservationBytes('retained upload files', nextRetainedFiles)
              if (nextRetainedBytes > leaseBytes || nextRetainedFiles > leaseFiles) {
                throw new Error('Retained upload resources cannot exceed the active reservation')
              }
              released = true
              // Only what stays on disk remains charged; the per-request minimum goes with the request.
              retainedCharge = nextRetainedBytes + nextRetainedFiles * uploadFileOverheadBytes
              retainedFiles = nextRetainedFiles
              retainedDirectory = options?.retainDirectory ?? false
              reservedBytes -= leaseCharge - retainedCharge
              reservedFiles -= leaseFiles - retainedFiles
              orphanedBytes += retainedCharge
              orphanedFiles += retainedFiles
              if (retainedDirectory) orphanedDirectories++
              activeUploads--
              emitState()
            }
          },
          releaseRetainedResources(): void {
            if (retainedCharge > 0 || retainedFiles > 0 || retainedDirectory) {
              reservedBytes -= retainedCharge
              orphanedBytes -= retainedCharge
              reservedFiles -= retainedFiles
              orphanedFiles -= retainedFiles
              if (retainedDirectory) orphanedDirectories--
              retainedCharge = 0
              retainedFiles = 0
              retainedDirectory = false
              emitState()
            }
          }
        }
      }
    }
  }
}
