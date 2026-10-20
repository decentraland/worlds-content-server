import { multipartParserWrapper } from '../../src/controllers/multipart'
import { stampRequestArrival } from '../../src/controllers/request-arrival'
import { setupRouter } from '../../src/controllers/routes'
import { GlobalContext } from '../../src/types'

jest.mock('../../src/controllers/multipart', () => ({
  ...jest.requireActual('../../src/controllers/multipart'),
  multipartParserWrapper: jest.fn(() => jest.fn())
}))
jest.mock('../../src/controllers/request-arrival', () => ({
  ...jest.requireActual('../../src/controllers/request-arrival'),
  stampRequestArrival: jest.fn(() => jest.fn())
}))

describe('when setting up the router', () => {
  let uploadTimeoutsByRoute: Record<string, unknown>
  let bodyReceivedByRoute: Record<string, unknown>

  beforeEach(async () => {
    // Mock resets between tests drop the module factory's implementation.
    jest.mocked(multipartParserWrapper).mockImplementation(() => jest.fn())
    jest.mocked(stampRequestArrival).mockImplementation(() => jest.fn())
    const globalContext = {
      components: {
        fetch: {},
        schemaValidator: { withSchemaValidatorMiddleware: jest.fn(() => jest.fn()) },
        config: { requireString: jest.fn().mockResolvedValue('secret') },
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
        metrics: { increment: jest.fn(), observe: jest.fn() },
        contentLocks: { withRead: jest.fn() },
        clientSource: {},
        sourceUploadLimits: { maxRequestBytes: 1024 },
        inFlightUploadBudget: {},
        uploadLimits: { multipartUploadTimeoutMs: 12_345 }
      }
    } as unknown as GlobalContext
    await setupRouter(globalContext)
    uploadTimeoutsByRoute = Object.fromEntries(
      jest.mocked(multipartParserWrapper).mock.calls.map(([, options]) => [options.route, options.uploadTimeoutMs])
    )
    bodyReceivedByRoute = Object.fromEntries(
      jest
        .mocked(multipartParserWrapper)
        .mock.calls.map(([, options]) => [options.route, typeof options.onBodyReceived])
    )
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should give the deployment and world settings parsers the configured multipart upload timeout', () => {
    expect(uploadTimeoutsByRoute).toEqual({ entities: 12_345, 'world-settings': 12_345 })
  })

  it('should report the body-receive time of the deployment and world settings parsers', () => {
    expect(bodyReceivedByRoute).toEqual({ entities: 'function', 'world-settings': 'function' })
  })

  it('should stamp the arrival of both multipart routes', () => {
    expect(stampRequestArrival).toHaveBeenCalledTimes(2)
  })
})
