export type InFlightUploadBudgetSnapshot = {
  capacity: number
  /** Charged bytes: payload plus per-file overhead, never below the per-request minimum. */
  reservedBytes: number
  orphanedBytes: number
  reservedFiles: number
  orphanedFiles: number
  orphanedDirectories: number
  activeUploads: number
  /** Concurrent small requests the budget admits: capacity / minUploadReservationBytes. */
  maxConcurrentUploads: number
  minUploadReservationBytes: number
  uploadFileOverheadBytes: number
  maxOrphanedUploadDirectories: number
}

export type InFlightUploadBudgetOptions = {
  /** Minimum bytes every admitted request reserves. Defaults to DEFAULT_MIN_UPLOAD_RESERVATION_BYTES. */
  minUploadReservationBytes?: number
  /** Bytes charged per uploaded file on top of its payload. Defaults to DEFAULT_UPLOAD_FILE_OVERHEAD_BYTES. */
  uploadFileOverheadBytes?: number
  /** Failed-cleanup directories tolerated before admission stops. */
  maxOrphanedUploadDirectories?: number
  /** Receives admitted-upload reservation state changes. */
  onStateChange?: (snapshot: InFlightUploadBudgetSnapshot) => void
}

export type InFlightUploadReleaseOptions = {
  /** Disk-backed bytes that remain after releasing the active upload. */
  retainBytes?: number
  /** Temporary files that remain after releasing the active upload. */
  retainFiles?: number
  /** Whether the temporary upload directory remains after releasing the active upload. */
  retainDirectory?: boolean
}

export type InFlightUploadLease = {
  /** Returns payload bytes currently accounted to this upload. */
  getPayloadBytes: () => number
  /** Returns temporary files currently accounted to this upload. */
  getReservedFiles: () => number
  /** Returns the bytes this upload charges against the budget. */
  getChargedBytes: () => number
  /** Changes the upload's payload bytes if aggregate capacity permits the resulting charge. */
  resize: (bytes: number) => boolean
  /** Changes the upload's temporary-file count if aggregate capacity permits the resulting charge. */
  resizeFiles: (files: number) => boolean
  /** Releases active resources, optionally retaining resources left on disk after failed cleanup. */
  release: (options?: InFlightUploadReleaseOptions) => void
  /** Releases retained disk resources after background cleanup succeeds. */
  releaseRetainedResources: () => void
}

export type InFlightUploadAcquisition =
  | { lease: InFlightUploadLease; rejectionReason?: undefined }
  | { lease?: undefined; rejectionReason: 'bytes' | 'storage' }

/**
 * Process-wide byte budget shared by every multipart route. Each admitted request charges
 * max(minUploadReservationBytes, payload + files × uploadFileOverheadBytes), so the one byte capacity
 * bounds disk bytes, concurrent requests and temporary files together.
 */
export type IInFlightUploadBudget = {
  capacity: number
  uploadFileOverheadBytes: number
  acquire: (bytes: number) => InFlightUploadAcquisition
  tryAcquireRejectedBodyDrain: () => (() => void) | undefined
  snapshot: () => InFlightUploadBudgetSnapshot
}
