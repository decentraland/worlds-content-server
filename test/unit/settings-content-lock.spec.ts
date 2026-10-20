import { createPgComponent } from '@dcl/pg-component'
import { createContentLocks } from '../../src/adapters/content-locks/component'
import { withSharedContentLock } from '../../src/controllers/routes'

jest.mock('@dcl/pg-component')

describe('when a settings update waits for a held content lock and its client disconnects', () => {
  let connect: jest.Mock
  let handler: jest.Mock
  let disconnect: Error
  let error: unknown

  beforeEach(async () => {
    jest.useFakeTimers()
    // The shared gate is never granted, so the lock wait keeps retrying.
    const client = {
      query: jest.fn(async () => ({ rows: [{ acquired: false }] })),
      release: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn()
    }
    connect = jest.fn(async () => client)
    jest.mocked(createPgComponent).mockResolvedValue({ getPool: () => ({ connect }) } as any)
    const contentLocks = await createContentLocks({
      config: { getNumber: async () => undefined } as any,
      logs: { getLogger: () => ({ warn: jest.fn() }) } as any,
      metrics: {} as any
    })
    handler = jest.fn()
    disconnect = new Error('client disconnected')
    const controller = new AbortController()
    setTimeout(() => controller.abort(disconnect), 100)
    error = 'still waiting'
    const update = withSharedContentLock(contentLocks, handler)({ request: { signal: controller.signal } })
    void update.catch((e: unknown) => {
      error = e
    })
    // Advanced past the disconnect so a wait that ignores it fails the assertion instead of hanging.
    await jest.advanceTimersByTimeAsync(1000)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.resetAllMocks()
  })

  it('should stop waiting with the disconnect after retrying, without running the handler', () => {
    expect({ error, retried: connect.mock.calls.length > 1, ran: handler.mock.calls.length }).toEqual({
      error: disconnect,
      retried: true,
      ran: 0
    })
  })
})
