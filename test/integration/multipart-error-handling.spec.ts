import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { cleanup, getIdentity } from '../utils'
import FormData from 'form-data'
import { hashV1 } from '@dcl/hashing'
import { MAX_ENTITY_FILE_SIZE_IN_BYTES } from '../../src/controllers/handlers/deploy-entity-handler'

test('POST /entities multipart error handling', function ({ components }) {
  afterEach(async () => {
    jest.resetAllMocks()
    const { storage, database } = components
    await cleanup(storage, database)
  })

  describe('when the multipart body is truncated', () => {
    let response: Response
    let body: unknown
    let limiterState: { reservedBytes: number; activeUploads: number }

    beforeEach(async () => {
      const { localFetch, metrics } = components
      const boundary = '----TestBoundary'
      const truncatedBody = `--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\nsome-id\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: application/octet-stream\r\n\r\nincomplete file da`
      // Body ends abruptly without closing boundary

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body: truncatedBody
      })
      body = await response.json()

      const [reservedBytesMetric, activeUploadsMetric] = await Promise.all([
        metrics.getValue('multipart_upload_reserved_bytes'),
        metrics.getValue('multipart_upload_active')
      ])
      limiterState = {
        reservedBytes: reservedBytesMetric.values[0]?.value,
        activeUploads: activeUploadsMetric.values[0]?.value
      }
    })

    it('should respond with 400 and the parse error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: { error: 'Bad request', message: 'Unexpected end of form' }
      })
    })

    it('should release all reserved bytes and the upload slot', () => {
      expect(limiterState).toEqual({ reservedBytes: 0, activeUploads: 0 })
    })
  })

  describe('when the entityId field is missing', () => {
    let response: Response
    let body: unknown

    beforeEach(async () => {
      const { localFetch } = components
      const form = new FormData()
      form.append('someOtherField', 'value')

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })
      body = await response.json()
    })

    it('should respond with 400 and a missing string error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: { error: 'Bad request', message: 'A string was expected' }
      })
    })
  })

  describe('when the content-type is not multipart/form-data', () => {
    let response: Response
    let body: unknown

    beforeEach(async () => {
      const { localFetch } = components

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ entityId: 'test' })
      })
      body = await response.json()
    })

    it('should respond with 400 and a content-type error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: { error: 'Bad request', message: 'Unsupported content type: application/json' }
      })
    })
  })

  describe('when the request has more fields than allowed', () => {
    let response: Response
    let body: unknown

    beforeEach(async () => {
      const { localFetch } = components
      const form = new FormData()
      for (let i = 0; i < 200; i++) {
        form.append(`field${i}`, 'x')
      }

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })
      body = await response.json()
    })

    it('should respond with 413 and a too-many-fields error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 413,
        body: {
          error: 'Payload Too Large',
          message: 'The multipart request has too many fields. The maximum allowed is 32.'
        }
      })
    })
  })

  describe('when a field exceeds the maximum field size', () => {
    let response: Response
    let body: unknown

    beforeEach(async () => {
      const { localFetch } = components
      const form = new FormData()
      form.append('entityId', 'x'.repeat(2 * 1024 * 1024))

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })
      body = await response.json()
    })

    it('should respond with 413 and a too-large error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 413,
        body: {
          error: 'Payload Too Large',
          message: "Field 'entityId' is too large. The maximum allowed size per field is 32768 bytes."
        }
      })
    })
  })

  describe('when the multipart body is empty', () => {
    let response: Response
    let body: unknown

    beforeEach(async () => {
      const { localFetch } = components
      const boundary = '----TestBoundary'
      const emptyBody = `--${boundary}--\r\n`

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body: emptyBody
      })
      body = await response.json()
    })

    it('should respond with 400 and a missing string error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: { error: 'Bad request', message: 'A string was expected' }
      })
    })
  })

  describe('when the entity content has an invalid structure', () => {
    let response: Response
    let body: unknown
    let storageLookup: jest.SpyInstance

    beforeEach(async () => {
      const { localFetch, storage } = components
      const entityFile = Buffer.from(
        JSON.stringify({
          version: 'v3',
          type: 'scene',
          pointers: ['0,0'],
          timestamp: Date.now(),
          content: {},
          metadata: {}
        })
      )
      const entityId = await hashV1(entityFile)
      const form = new FormData()
      form.append('entityId', entityId)
      form.append('authChain[0][payload]', 'invalid')
      form.append('authChain[0][signature]', 'invalid')
      form.append('authChain[0][type]', 'SIGNER')
      form.append(entityId, entityFile, { filename: entityId })
      storageLookup = jest.spyOn(storage, 'existMultiple')

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })
      body = await response.json()
    })

    afterEach(() => {
      storageLookup.mockRestore()
    })

    it('should respond with a client validation error', () => {
      expect({ status: response.status, body }).toEqual({
        status: 400,
        body: { error: 'Bad request', message: expect.stringMatching(/^Deployment failed: /) }
      })
    })

    it('should reject the entity before querying content storage', () => {
      expect(storageLookup).not.toHaveBeenCalled()
    })
  })

  describe('when the entity file exceeds the safe in-memory size', () => {
    let response: Response
    let body: unknown
    let storageLookup: jest.SpyInstance
    let limiterState: { reservedBytes: number; reservedFiles: number; activeUploads: number }

    beforeEach(async () => {
      const { localFetch, metrics, storage } = components
      const entityId = 'oversized-entity'
      const identity = await getIdentity()
      const form = new FormData()
      form.append('entityId', entityId)
      // Validly signed, so the request reaches the entity size check.
      Authenticator.signPayload(identity.authChain, entityId).forEach((link, i) => {
        form.append(`authChain[${i}][type]`, link.type)
        form.append(`authChain[${i}][payload]`, link.payload)
        form.append(`authChain[${i}][signature]`, link.signature)
      })
      form.append(entityId, Buffer.alloc(MAX_ENTITY_FILE_SIZE_IN_BYTES + 1), { filename: entityId })
      storageLookup = jest.spyOn(storage, 'existMultiple')

      response = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer()
      })
      body = await response.json()

      const [reservedBytesMetric, reservedFilesMetric, activeUploadsMetric] = await Promise.all([
        metrics.getValue('multipart_upload_reserved_bytes'),
        metrics.getValue('multipart_upload_reserved_files'),
        metrics.getValue('multipart_upload_active')
      ])
      limiterState = {
        reservedBytes: reservedBytesMetric.values[0]?.value,
        reservedFiles: reservedFilesMetric.values[0]?.value,
        activeUploads: activeUploadsMetric.values[0]?.value
      }
    })

    afterEach(() => {
      storageLookup.mockRestore()
    })

    it('should reject the request before querying content storage', () => {
      expect({ status: response.status, body, storageLookups: storageLookup.mock.calls.length }).toEqual({
        status: 400,
        body: {
          error: 'Bad request',
          message: `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
        },
        storageLookups: 0
      })
    })

    it('should release the upload bytes, temporary file, and upload slot', () => {
      expect(limiterState).toEqual({ reservedBytes: 0, reservedFiles: 0, activeUploads: 0 })
    })
  })
})
