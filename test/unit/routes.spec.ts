import { multipartParserWrapper } from '../../src/controllers/multipart'
import { setupRouter } from '../../src/controllers/routes'
import { GlobalContext } from '../../src/types'

jest.mock('../../src/controllers/multipart', () => ({
  ...jest.requireActual('../../src/controllers/multipart'),
  multipartParserWrapper: jest.fn(() => jest.fn())
}))

describe('when setting up the router', () => {
  let uploadTimeoutsByRoute: Record<string, unknown>

  beforeEach(async () => {
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
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should give the deployment and world settings parsers the configured multipart upload timeout', () => {
    expect(uploadTimeoutsByRoute).toEqual({ entities: 12_345, 'world-settings': 12_345 })
  })
})
