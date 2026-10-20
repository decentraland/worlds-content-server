import { InvalidRequestError } from '@dcl/http-commons'

/** The upload outlived its fixed lifetime; the client must start over with a fresh entity. */
export class PartialUploadExpiredError extends InvalidRequestError {
  constructor() {
    super('This upload expired. Create a new entity with a fresh timestamp.')
    this.name = 'PartialUploadExpiredError'
  }
}
