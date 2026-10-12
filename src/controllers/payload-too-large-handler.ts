import { IHttpServerComponent } from '@dcl/core-commons'
import { PayloadTooLargeError } from '../logic/multipart'

/**
 * Answers {@link PayloadTooLargeError} with 413, as `@dcl/http-commons`' errorHandler has no mapping for it.
 * @returns Middleware to register right after the shared errorHandler; every other error is rethrown to it.
 */
export function payloadTooLargeHandler(): (
  context: object,
  next: () => Promise<IHttpServerComponent.IResponse>
) => Promise<IHttpServerComponent.IResponse> {
  return async (_context, next) => {
    try {
      return await next()
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return { status: 413, body: { error: 'Payload Too Large', message: error.message } }
      }
      throw error
    }
  }
}
