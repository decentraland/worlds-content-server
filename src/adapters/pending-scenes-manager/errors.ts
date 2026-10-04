import { InvalidRequestError } from '@dcl/http-commons'

/** The upload outlived its fixed lifetime; the client must start over with a fresh entity. */
export class PartialUploadExpiredError extends InvalidRequestError {
  constructor() {
    super('This upload expired. Create a new entity with a fresh timestamp.')
    this.name = 'PartialUploadExpiredError'
  }
}

/** Which partial-upload quota rejected a batch. */
type PartialUploadQuota = 'uploads_per_account' | 'bytes_per_account' | 'bytes_per_server' | 'bytes_per_minute'

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
    readonly quota: Extract<PartialUploadQuota, 'bytes_per_account' | 'bytes_per_minute'>,
    message: string
  ) {
    super(message)
    this.name = 'PartialUploadTooLargeError'
  }
}
