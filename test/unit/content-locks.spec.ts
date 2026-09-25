import { createPgComponent } from '@dcl/pg-component'
import { createContentLocks } from '../../src/adapters/content-locks/component'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'

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

type FakeClient = {
  query: jest.Mock
  release: jest.Mock
  on: jest.Mock
  removeListener: jest.Mock
}

function statementText(sql: string | { text: string }): string {
  return typeof sql === 'string' ? sql : sql.text
}

function createFakeClient(respond: (sql: string) => Promise<unknown>): FakeClient {
  return {
    query: jest.fn((sql: string | { text: string }) => respond(statementText(sql))),
    release: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn()
  }
}

async function createLocksWith(client: FakeClient) {
  jest.mocked(createPgComponent).mockResolvedValue({ getPool: () => ({ connect: async () => client }) } as any)
  return createContentLocks({
    config: { getNumber: async () => undefined } as any,
    logs: {} as any,
    metrics: {} as any
  })
}

describe('when an upload holds its content locks', () => {
  let client: FakeClient
  let operationError: Error
  let error: unknown
  let statements: string[]

  beforeEach(() => {
    client = createFakeClient(async () => ({ rows: [{ acquired: true }], rowCount: 1 }))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the operation fails', () => {
    beforeEach(async () => {
      const locks = await createLocksWith(client)
      operationError = new Error('invalid deployment')
      error = await locks
        .withRead(() => Promise.reject(operationError), new AbortController().signal, 'an-entity')
        .catch((e) => e)
      statements = client.query.mock.calls.map(([sql]) => statementText(sql))
    })

    it('should unlock the session and return its healthy connection to the pool', () => {
      expect({
        error,
        unlocked: statements.includes('SELECT pg_advisory_unlock_all()'),
        release: client.release.mock.calls
      }).toEqual({
        error: operationError,
        unlocked: true,
        release: [[false]]
      })
    })
  })

  describe('and the connection breaks while the operation runs', () => {
    beforeEach(async () => {
      const locks = await createLocksWith(client)
      operationError = new Error('Connection terminated unexpectedly')
      error = await locks
        .withRead(
          async () => {
            const [, onError] = client.on.mock.calls[0]
            onError(operationError)
            throw operationError
          },
          new AbortController().signal,
          'an-entity'
        )
        .catch((e) => e)
      statements = client.query.mock.calls.map(([sql]) => statementText(sql))
    })

    it('should destroy the connection without trying to unlock it', () => {
      expect({
        error,
        unlocked: statements.includes('SELECT pg_advisory_unlock_all()'),
        release: client.release.mock.calls
      }).toEqual({
        error: operationError,
        unlocked: false,
        release: [[true]]
      })
    })
  })
})

describe('when the request is cancelled while a lock query is still running', () => {
  let client: FakeClient
  let operation: jest.Mock
  let cancellation: Error
  let error: unknown

  beforeEach(async () => {
    client = createFakeClient((sql) =>
      sql.startsWith('SELECT pg_try_advisory') ? new Promise(() => undefined) : Promise.resolve({ rows: [] })
    )
    const locks = await createLocksWith(client)
    operation = jest.fn()
    cancellation = new Error('client disconnected')
    const controller = new AbortController()
    setTimeout(() => controller.abort(cancellation), 20)
    error = await locks.withRead(operation, controller.signal, 'an-entity').catch((e) => e)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should destroy the connection so the abandoned lock query cannot leave a lock in the pool', () => {
    expect({ error, ran: operation.mock.calls.length, release: client.release.mock.calls }).toEqual({
      error: cancellation,
      ran: 0,
      release: [[true]]
    })
  })
})

describe('when a writer gives up waiting for the exclusive gate', () => {
  let client: FakeClient
  let statements: string[]
  let error: unknown

  beforeEach(async () => {
    client = createFakeClient(async (sql) => {
      if (sql.includes('pg_advisory_lock(')) throw Object.assign(new Error('lock timeout'), { code: '55P03' })
      return { rows: [], rowCount: 0 }
    })
    jest.mocked(createPgComponent).mockResolvedValue({ getPool: () => ({ connect: async () => client }) } as any)
    const locks = await createContentLocks(
      { config: { getNumber: async () => undefined } as any, logs: {} as any, metrics: {} as any },
      { writerLockTimeoutMs: 1, writerMaxWaitMs: 0 }
    )
    error = await locks.withWrite(jest.fn()).catch((e) => e)
    statements = client.query.mock.calls.map(([sql]) => statementText(sql))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should reset its lock timeout and return the connection to the pool', () => {
    expect({
      timedOut: error instanceof ContentLockTimeoutError,
      reset: statements.includes('RESET lock_timeout'),
      release: client.release.mock.calls
    }).toEqual({ timedOut: true, reset: true, release: [[false]] })
  })
})
