import { InvalidRequestError } from '@dcl/http-commons'

export { PartialUploadExpiredError } from '../../adapters/pending-scenes-repository/errors'

/** Another account started the upload; reservations are charged to its creator. */
export class PartialUploadOwnershipError extends InvalidRequestError {
  constructor() {
    super('This upload was started by another account.')
    this.name = 'PartialUploadOwnershipError'
  }
}

/** The upload is gone before its batch was reserved; the client must resend its manifest. */
export class PartialUploadNotFoundError extends InvalidRequestError {
  constructor() {
    super('Upload no longer exists; resend its manifest.')
    this.name = 'PartialUploadNotFoundError'
  }
}

/** Which partial-upload quota rejected a batch. */
type PartialUploadQuota =
  | 'uploads_per_account'
  | 'uploads_per_world'
  | 'bytes_per_account'
  | 'bytes_per_world'
  | 'bytes_per_server'
  | 'bytes_per_minute'

/** A partial-upload quota is full for now; the batch may be retried after `retryAfterSeconds`. */
export class PartialUploadQuotaExceededError extends Error {
  constructor(
    readonly quota: PartialUploadQuota,
    message: string,
    readonly retryAfterSeconds: number
  ) {
    super(message)
    this.name = 'PartialUploadQuotaExceededError'
  }
}

/** A batch or upload exceeds a partial-upload quota on its own, so no retry can succeed. */
export class PartialUploadTooLargeError extends InvalidRequestError {
  constructor(
    readonly quota: Extract<PartialUploadQuota, 'bytes_per_account' | 'bytes_per_world' | 'bytes_per_minute'>,
    message: string
  ) {
    super(message)
    this.name = 'PartialUploadTooLargeError'
  }
}
