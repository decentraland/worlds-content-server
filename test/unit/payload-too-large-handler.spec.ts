import { InvalidRequestError } from '@dcl/http-commons'
import { payloadTooLargeHandler } from '../../src/controllers/payload-too-large-handler'
import { PayloadTooLargeError } from '../../src/logic/multipart'

describe('payloadTooLargeHandler', () => {
  let next: jest.Mock

  beforeEach(() => {
    next = jest.fn()
  })

  describe('when the next middleware throws a payload-too-large error', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new PayloadTooLargeError('The multipart request is too large.'))
      response = await payloadTooLargeHandler()({}, next)
    })

    it('should respond with 413 and the error message', () => {
      expect(response).toEqual({
        status: 413,
        body: { error: 'Payload Too Large', message: 'The multipart request is too large.' }
      })
    })
  })

  describe('when the next middleware throws any other error', () => {
    let error: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new InvalidRequestError("Duplicate form field 'dup'"))
      error = await payloadTooLargeHandler()({}, next).catch((e) => e)
    })

    it('should rethrow it to the shared error handler', () => {
      expect(error).toBeInstanceOf(InvalidRequestError)
    })
  })

  describe('when the next middleware responds', () => {
    let response: unknown

    beforeEach(async () => {
      next.mockResolvedValueOnce({ status: 200 })
      response = await payloadTooLargeHandler()({}, next)
    })

    it('should return its response unchanged', () => {
      expect(response).toEqual({ status: 200 })
    })
  })
})
