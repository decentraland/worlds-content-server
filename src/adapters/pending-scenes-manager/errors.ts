import { InvalidRequestError } from '@dcl/http-commons'

/** The upload outlived its fixed lifetime; the client must start over with a fresh entity. */
export class PartialUploadExpiredError extends InvalidRequestError {
  constructor() {
    super('This upload expired. Create a new entity with a fresh timestamp.')
    this.name = 'PartialUploadExpiredError'
  }
}

/** Which partial-upload quota rejected a batch. */
export type PartialUploadQuota = 'uploads_per_account' | 'bytes_per_account' | 'bytes_per_server' | 'bytes_per_minute'

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
