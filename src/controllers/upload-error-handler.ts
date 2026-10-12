import { IHttpServerComponent } from '@dcl/core-commons'
import { PayloadTooLargeError, UploadTimeoutError, UploadUnavailableError } from '../logic/multipart'
import { SourceUploadLimitExceededError } from '../adapters/source-upload-limits'
import { DeploymentProcessingAbortedError, DeploymentProcessingTimeoutError } from '../logic/deployment-processing'
import { PartialUploadQuotaExceededError } from '../logic/partial-upload-admission'
import { SceneReplacementConflictError } from '../types'

// A shed upload frees capacity as soon as any in-flight upload ends.
const UPLOAD_UNAVAILABLE_RETRY_AFTER_SECONDS = 5
// A slot frees when one of the source's uploads ends, which the source itself controls.
const SOURCE_UPLOAD_RETRY_AFTER_SECONDS = 5

/**
 * Maps the errors a deployment answers itself. The deploy handler returns these responses rather than
 * throwing, so the multipart parser still reports the upload as completed.
 * @param error The error the deployment failed with.
 * @returns The response for it, or undefined when it isn't one of these errors.
 */
export function toDeploymentErrorResponse(error: unknown): IHttpServerComponent.IResponse | undefined {
  if (error instanceof DeploymentProcessingAbortedError) {
    // The transport is already gone in production; this keeps the expected cancellation out of the
    // global error handler's warning/500 path in direct or mocked callers.
    return { status: 499, body: { error: 'Client Closed Request', message: error.message } }
  }
  if (error instanceof DeploymentProcessingTimeoutError) {
    return { status: 408, body: { error: 'Request Timeout', message: error.message } }
  }
  if (error instanceof PartialUploadQuotaExceededError) {
    return {
      status: 429,
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
      body: { error: 'Too Many Requests', message: error.message }
    }
  }
  if (error instanceof SceneReplacementConflictError) {
    return { status: 409, body: { error: 'Conflict', message: error.message } }
  }
  return undefined
}

/**
 * Maps every upload error to its HTTP response; `@dcl/http-commons`' errorHandler has no mapping for any
 * of them. Deployment errors are mapped by the deploy handler itself (see {@link toDeploymentErrorResponse}).
 * @param error The error a request failed with.
 * @returns The response for it, or undefined when the shared errorHandler should handle it.
 */
export function toUploadErrorResponse(error: unknown): IHttpServerComponent.IResponse | undefined {
  // Over a size or count limit, as on Catalyst.
  if (error instanceof PayloadTooLargeError) {
    return { status: 413, body: { error: 'Payload Too Large', message: error.message } }
  }
  if (error instanceof UploadUnavailableError) {
    return {
      status: 503,
      headers: { 'Retry-After': String(UPLOAD_UNAVAILABLE_RETRY_AFTER_SECONDS) },
      body: { error: 'Service Unavailable', message: error.message }
    }
  }
  if (error instanceof UploadTimeoutError) {
    return { status: 408, headers: {}, body: { error: 'Request Timeout', message: error.message } }
  }
  if (error instanceof SourceUploadLimitExceededError) {
    return {
      status: 429,
      headers: { 'Retry-After': String(SOURCE_UPLOAD_RETRY_AFTER_SECONDS) },
      body: { error: 'Too Many Requests', message: error.message }
    }
  }
  return undefined
}

/**
 * Answers upload errors with their HTTP responses (see {@link toUploadErrorResponse}).
 * @returns Middleware to register right after the shared errorHandler; every other error is rethrown to it.
 */
export function uploadErrorHandler(): (
  context: object,
  next: () => Promise<IHttpServerComponent.IResponse>
) => Promise<IHttpServerComponent.IResponse> {
  return async (_context, next) => {
    try {
      return await next()
    } catch (error) {
      const response = toUploadErrorResponse(error)
      if (response) return response
      throw error
    }
  }
}
