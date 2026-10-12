import {
  createSourceUploadLimits,
  ISourceUploadLimits,
  SourceUploadLimitExceededError
} from '../../src/adapters/source-upload-limits'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES } from '../../src/logic/multipart'

const MAX_REQUEST_BYTES = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES

describe('when limiting in-flight uploads per source', () => {
  let settings: Record<string, number | undefined>

  function create(): Promise<ISourceUploadLimits> {
    return createSourceUploadLimits({ config: { getNumber: jest.fn(async (key: string) => settings[key]) } as never })
  }

  beforeEach(() => {
    settings = { MAX_CONCURRENT_UPLOADS_PER_SOURCE: 2 }
  })

  describe('and the per-source byte share cannot fit one maximum-size upload', () => {
    let creationError: unknown

    beforeEach(async () => {
      settings.MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE = MAX_REQUEST_BYTES - 1
      creationError = await create().catch((error: unknown) => error)
    })

    it('should fail to start', () => {
      expect(creationError).toEqual(
        expect.objectContaining({ message: expect.stringContaining('MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE') })
      )
    })
  })

  describe('and nothing configures the limits', () => {
    let limits: ISourceUploadLimits
    let admitted: number
    let rejection: unknown

    beforeEach(async () => {
      settings = {}
      limits = await create()
      admitted = 0
      rejection = undefined
      try {
        for (let i = 0; i < 5; i++) {
          limits.acquire('203.0.113.1', 1)
          admitted++
        }
      } catch (error) {
        rejection = error
      }
    })

    it('should admit four concurrent uploads per source', () => {
      expect({ admitted, reason: (rejection as SourceUploadLimitExceededError).reason }).toEqual({
        admitted: 4,
        reason: 'source_concurrency'
      })
    })

    it('should size the byte share for one maximum-size upload', () => {
      expect(limits.maxRequestBytes).toBe(MAX_REQUEST_BYTES)
    })
  })

  describe('and a source already has its concurrency share in flight', () => {
    let limits: ISourceUploadLimits
    let sameSourceError: unknown
    let otherSourceError: unknown

    beforeEach(async () => {
      limits = await create()
      limits.acquire('203.0.113.1', 1)
      limits.acquire('203.0.113.1', 1)
      sameSourceError = catchAcquire(limits, '203.0.113.1', 1)
      otherSourceError = catchAcquire(limits, '203.0.113.2', 1)
    })

    it('should reject another upload from that source', () => {
      expect(sameSourceError).toEqual(new SourceUploadLimitExceededError('source_concurrency'))
    })

    it('should still admit uploads from other sources', () => {
      expect(otherSourceError).toBeUndefined()
    })
  })

  describe('and a source already has its byte share in flight', () => {
    let limits: ISourceUploadLimits
    let error: unknown

    beforeEach(async () => {
      limits = await create()
      limits.acquire('203.0.113.1', MAX_REQUEST_BYTES)
      error = catchAcquire(limits, '203.0.113.1', 1)
    })

    it('should reject another upload from that source', () => {
      expect(error).toEqual(new SourceUploadLimitExceededError('source_bytes'))
    })
  })

  describe('and an upload of a source at its share is released', () => {
    let limits: ISourceUploadLimits
    let error: unknown

    beforeEach(async () => {
      limits = await create()
      const lease = limits.acquire('203.0.113.1', MAX_REQUEST_BYTES)
      limits.acquire('203.0.113.1', 0)
      lease.release()
      lease.release()
      limits.acquire('203.0.113.1', MAX_REQUEST_BYTES)
      error = catchAcquire(limits, '203.0.113.1', 0)
    })

    it('should return its share once, however often it is released', () => {
      expect(error).toEqual(new SourceUploadLimitExceededError('source_concurrency'))
    })
  })
})

function catchAcquire(limits: ISourceUploadLimits, source: string, bytes: number): unknown {
  try {
    limits.acquire(source, bytes)
    return undefined
  } catch (error) {
    return error
  }
}
