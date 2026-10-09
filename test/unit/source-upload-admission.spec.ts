import { IHttpServerComponent } from '@dcl/core-commons'
import { SourceUploadLimitExceededError } from '../../src/adapters/source-upload-limits'
import { createSourceUploadAdmission } from '../../src/controllers/source-upload-admission'
import { IClientSourceComponent } from '../../src/logic/client-source'

describe('when admitting a multipart upload by its source', () => {
  let acquire: jest.Mock
  let release: jest.Mock
  let increment: jest.Mock
  let next: jest.Mock
  let headers: Record<string, string>
  let clientSource: IClientSourceComponent
  let admission: ReturnType<typeof createSourceUploadAdmission>

  function context(): IHttpServerComponent.DefaultContext {
    return { request: { headers: new Headers(headers) } } as unknown as IHttpServerComponent.DefaultContext
  }

  beforeEach(() => {
    release = jest.fn()
    acquire = jest.fn().mockReturnValue({ release })
    increment = jest.fn()
    next = jest.fn().mockResolvedValue({ status: 200 })
    headers = { 'cf-connecting-ip': '203.0.113.1', 'content-length': '500' }
    clientSource = {
      header: 'cf-connecting-ip',
      getClientSource: (request) => request.headers.get('cf-connecting-ip') || undefined
    }
    admission = createSourceUploadAdmission(
      { clientSource, metrics: { increment } as never, sourceUploadLimits: { maxRequestBytes: 1_000, acquire } },
      { route: 'entities', maxRequestBytes: 800 }
    )
  })

  describe('and the request declares its length', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      response = await admission(context(), next)
    })

    it('should charge the declared length to the client source', () => {
      expect(acquire).toHaveBeenCalledWith('203.0.113.1', 500)
    })

    it('should pass the request on and release its share when it ends', () => {
      expect({ response, releases: release.mock.calls.length }).toEqual({ response: { status: 200 }, releases: 1 })
    })
  })

  describe('and the declared length exceeds what the route accepts', () => {
    beforeEach(async () => {
      headers['content-length'] = '5000'
      await admission(context(), next)
    })

    it("should charge the route's maximum", () => {
      expect(acquire).toHaveBeenCalledWith('203.0.113.1', 800)
    })
  })

  describe('and the request declares no length', () => {
    beforeEach(async () => {
      delete headers['content-length']
      await admission(context(), next)
    })

    it("should charge the route's maximum", () => {
      expect(acquire).toHaveBeenCalledWith('203.0.113.1', 800)
    })
  })

  describe('and the client source is resolved from another trusted header', () => {
    beforeEach(async () => {
      headers['x-real-ip'] = '198.51.100.7'
      clientSource.getClientSource = (request) => request.headers.get('x-real-ip') || undefined
      await admission(context(), next)
    })

    it('should charge the source that header reports', () => {
      expect(acquire).toHaveBeenCalledWith('198.51.100.7', 500)
    })
  })

  describe('and the client source is unknown', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      delete headers['cf-connecting-ip']
      response = await admission(context(), next)
    })

    it('should pass the request on without charging any per-source share', () => {
      expect({ response, acquired: acquire.mock.calls.length }).toEqual({ response: { status: 200 }, acquired: 0 })
    })

    it('should count it as unattributed', () => {
      expect(increment).toHaveBeenCalledWith('multipart_upload_unattributed', { route: 'entities' })
    })
  })

  describe('and the source already has its share in flight', () => {
    let response: IHttpServerComponent.IResponse

    beforeEach(async () => {
      acquire.mockImplementationOnce(() => {
        throw new SourceUploadLimitExceededError('source_concurrency')
      })
      response = await admission(context(), next)
    })

    it('should answer 429 with a retry hint before the body is read', () => {
      expect({ status: response.status, headers: response.headers, nextCalls: next.mock.calls.length }).toEqual({
        status: 429,
        headers: { 'Retry-After': '5' },
        nextCalls: 0
      })
    })

    it('should count the rejection', () => {
      expect(increment).toHaveBeenCalledWith('multipart_upload_rejections', {
        route: 'entities',
        reason: 'source_concurrency'
      })
    })
  })

  describe('and the request fails', () => {
    let caughtError: unknown

    beforeEach(async () => {
      next.mockRejectedValueOnce(new Error('client went away'))
      caughtError = await admission(context(), next).catch((error: unknown) => error)
    })

    it('should propagate the failure', () => {
      expect(caughtError).toEqual(new Error('client went away'))
    })

    it('should release its share', () => {
      expect(release).toHaveBeenCalledTimes(1)
    })
  })
})
