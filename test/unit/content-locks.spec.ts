import { createPgComponent } from '@dcl/pg-component'
import { createContentLocks } from '../../src/adapters/content-locks/component'

jest.mock('@dcl/pg-component')

describe('when the lock pool times out while opening a new connection', () => {
  let connect: jest.Mock
  let operation: jest.Mock
  let deadline: Error
  let error: unknown

  beforeEach(async () => {
    connect = jest.fn().mockRejectedValue(new Error('Connection terminated due to connection timeout'))
    jest.mocked(createPgComponent).mockResolvedValue({ getPool: () => ({ connect }) } as any)
    operation = jest.fn()
    const locks = await createContentLocks({
      config: { getNumber: async () => undefined } as any,
      logs: {} as any,
      metrics: {} as any
    })
    deadline = new Error('processing deadline')
    const controller = new AbortController()
    setTimeout(() => controller.abort(deadline), 200)
    error = await locks.withRead(operation, controller.signal, 'an-entity').catch((e) => e)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should keep retrying like a busy lock until the request deadline without running the operation', () => {
    expect({ error, retried: connect.mock.calls.length > 1, ran: operation.mock.calls.length }).toEqual({
      error: deadline,
      retried: true,
      ran: 0
    })
  })
})
