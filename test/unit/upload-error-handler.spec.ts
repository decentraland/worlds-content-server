import { InvalidRequestError } from '@dcl/http-commons'
import { IHttpServerComponent } from '@dcl/core-commons'
import { toDeploymentErrorResponse, uploadErrorHandler } from '../../src/controllers/upload-error-handler'
import {
  describeUploadTimeout,
  PayloadTooLargeError,
  UploadTimeoutError,
  UploadUnavailableError
} from '../../src/logic/multipart'
import { SourceUploadLimitExceededError } from '../../src/adapters/source-upload-limits'
import {
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError
} from '../../src/logic/deployment-processing'
import { PartialUploadQuotaExceededError } from '../../src/logic/partial-upload-admission'
import { SceneReplacementConflictError } from '../../src/types'

describe('uploadErrorHandler', () => {
  let next: jest.Mock

  beforeEach(() => {
    next = jest.fn()
  })

  describe('when the next middleware throws a payload-too-large error', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new PayloadTooLargeError('The multipart request is too large.'))
      response = await uploadErrorHandler()({}, next)
    })

    it('should respond with 413 and the error message', () => {
      expect(response).toEqual({
        status: 413,
        body: { error: 'Payload Too Large', message: 'The multipart request is too large.' }
      })
    })
  })

  describe('when the next middleware throws an upload capacity error', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(
        new UploadUnavailableError('bytes', 'Server is buffering too many uploads, please retry shortly.', 0)
      )
      response = await uploadErrorHandler()({}, next)
    })

    it('should respond with 503, a retry hint and the error message', () => {
      expect(response).toEqual({
        status: 503,
        headers: { 'Retry-After': '5' },
        body: { error: 'Service Unavailable', message: 'Server is buffering too many uploads, please retry shortly.' }
      })
    })
  })

  describe('when the next middleware throws an upload timeout error', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new UploadTimeoutError(10, 1_000, 2_048, 4_096))
      response = await uploadErrorHandler()({}, next)
    })

    it('should respond with 408 and a message stating what was received', () => {
      expect(response).toEqual({
        status: 408,
        headers: {},
        body: { error: 'Request Timeout', message: describeUploadTimeout(1_000, 2_048, 4_096) }
      })
    })
  })

  describe('when the next middleware throws a source upload limit error', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new SourceUploadLimitExceededError('source_bytes'))
      response = await uploadErrorHandler()({}, next)
    })

    it('should respond with 429, a retry hint and the error message', () => {
      expect(response).toEqual({
        status: 429,
        headers: { 'Retry-After': '5' },
        body: {
          error: 'Too Many Requests',
          message: 'Too many uploads in progress from this client, please retry shortly.'
        }
      })
    })
  })

  describe('when the next middleware throws a deployment error', () => {
    let thrown: SceneReplacementConflictError
    let error: unknown

    beforeEach(async () => {
      thrown = new SceneReplacementConflictError('world.dcl.eth')
      next.mockRejectedValueOnce(thrown)
      error = await uploadErrorHandler()({}, next).catch((e) => e)
    })

    it('should not map it and rethrow it, since the deploy handler answers it', () => {
      expect(error).toBe(thrown)
    })
  })

  describe('when the next middleware throws any other error', () => {
    let error: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new InvalidRequestError("Duplicate form field 'dup'"))
      error = await uploadErrorHandler()({}, next).catch((e) => e)
    })

    it('should rethrow it to the shared error handler', () => {
      expect(error).toBeInstanceOf(InvalidRequestError)
    })
  })

  describe('when the next middleware responds', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockResolvedValueOnce({ status: 200 })
      response = await uploadErrorHandler()({}, next)
    })

    it('should return its response unchanged', () => {
      expect(response).toEqual({ status: 200 })
    })
  })
})

describe('toDeploymentErrorResponse', () => {
  let response: IHttpServerComponent.IResponse | undefined

  describe('when the client closed the request', () => {
    beforeEach(() => {
      response = toDeploymentErrorResponse(
        new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError'))
      )
    })

    it('should answer 499 with the abort message', () => {
      expect(response).toEqual({
        status: 499,
        body: { error: 'Client Closed Request', message: 'Client disconnected.' }
      })
    })
  })

  describe('when the deployment exceeded its processing deadline', () => {
    beforeEach(() => {
      response = toDeploymentErrorResponse(new DeploymentProcessingTimeoutError(10))
    })

    it('should answer 408 with the timeout message', () => {
      expect(response).toEqual({
        status: 408,
        body: { error: 'Request Timeout', message: new DeploymentProcessingTimeoutError(10).message }
      })
    })
  })

  describe('when a partial-upload quota is full', () => {
    beforeEach(() => {
      response = toDeploymentErrorResponse(
        new PartialUploadQuotaExceededError('bytes_per_minute', 'This account sent too much this minute.', 42)
      )
    })

    it("should answer 429 with the quota's Retry-After", () => {
      expect(response).toEqual({
        status: 429,
        headers: { 'Retry-After': '42' },
        body: { error: 'Too Many Requests', message: 'This account sent too much this minute.' }
      })
    })
  })

  describe('when the authorized scene replacement changed', () => {
    beforeEach(() => {
      response = toDeploymentErrorResponse(new SceneReplacementConflictError('world.dcl.eth'))
    })

    it('should answer 409 so the client can retry authorization', () => {
      expect(response).toEqual({
        status: 409,
        body: {
          error: 'Conflict',
          message: 'Scene replacement authorization changed while deploying to world "world.dcl.eth". Please retry.'
        }
      })
    })
  })

  describe('when the error is an upload error', () => {
    beforeEach(() => {
      response = toDeploymentErrorResponse(new PayloadTooLargeError('The multipart request is too large.'))
    })

    it('should leave it to the upload error handler', () => {
      expect(response).toBeUndefined()
    })
  })
})
