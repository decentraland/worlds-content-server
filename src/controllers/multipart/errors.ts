import { formatBytes } from '../../logic/utils'
import { MultipartRejectionReason } from './types'

/** A multipart body over a size or count limit; answered with 413, as on Catalyst. */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

export class MultipartRejectionError extends Error {
  constructor(
    readonly reason: MultipartRejectionReason,
    message: string,
    readonly actualBytes: number
  ) {
    super(message)
  }
}

/** The server can't take the upload right now; answered with 503 and Retry-After. */
export class UploadUnavailableError extends MultipartRejectionError {}

export class UploadCapacityError extends UploadUnavailableError {
  constructor(actualBytes: number) {
    super('bytes', 'Server is buffering too many uploads, please retry shortly.', actualBytes)
  }
}

/** Describes a body that didn't arrive in time with what was measured, so a creator can report it. */
export function describeUploadTimeout(timeoutMs: number, receivedBytes: number, declaredBytes?: number): string {
  const seconds = timeoutMs / 1000
  const received =
    declaredBytes === undefined
      ? formatBytes(receivedBytes)
      : `${formatBytes(receivedBytes)} of ${formatBytes(declaredBytes)}`
  const rate = (receivedBytes / 1024 / seconds).toFixed(1)
  return (
    `The upload did not finish within ${seconds} s: received ${received} (about ${rate} KiB/s). ` +
    'Retry on a faster connection or send smaller batches.'
  )
}

/** The body didn't arrive within the upload timeout; answered with 408. */
export class UploadTimeoutError extends MultipartRejectionError {
  constructor(actualBytes: number, timeoutMs: number, receivedBytes: number, declaredBytes?: number) {
    super('timeout', describeUploadTimeout(timeoutMs, receivedBytes, declaredBytes), actualBytes)
  }
}

/** A size or count limit violation, answered with 413 rather than 400. */
export class UploadLimitError extends MultipartRejectionError {}

export class UploadWireSizeError extends UploadLimitError {
  constructor(actualBytes: number) {
    super('wire_size', 'The multipart request is too large.', actualBytes)
  }
}

export class UploadPayloadSizeError extends UploadLimitError {
  constructor(message: string, actualBytes: number) {
    super('payload_size', message, actualBytes)
  }
}

export class UploadStorageError extends UploadUnavailableError {
  constructor(actualBytes: number) {
    super('storage', 'The server could not store the multipart upload, please retry shortly.', actualBytes)
  }
}

export class UploadFileCapacityError extends UploadUnavailableError {
  constructor(actualBytes: number) {
    super('files', 'Server is buffering too many upload files, please retry shortly.', actualBytes)
  }
}

export class UploadCountLimitError extends UploadLimitError {
  constructor(message: string, actualBytes: number) {
    super('invalid_multipart', message, actualBytes)
  }
}

export class InvalidMultipartBodyError extends MultipartRejectionError {
  constructor(message: string, actualBytes: number) {
    super('invalid_multipart', message, actualBytes)
  }
}
