import { ILoggerComponent, START_COMPONENT } from '@well-known-components/interfaces'
import {
  createMigrationExecutor,
  MigrationExecutor,
  MigrationExecutorComponents,
  MigrationsLockLostError
} from '../../src/adapters/migration-executor'
import { Migration } from '../../src/types'

type Query = string | { text: string; values: unknown[] }

function textOf(query: Query): string {
  return typeof query === 'string' ? query : query.text
}

describe('MigrationExecutor', () => {
  let events: string[]
  let appliedMigrations: string[]
  let lockAttempts: boolean[]
  let failingMigrationId: string | undefined
  let dropBeforeStatementMigrationId: string | undefined
  let dropAfterStatementMigrationId: string | undefined
  let dropAfterRecordMigrationId: string | undefined
  let connectionErrorListener: ((error: Error) => void) | undefined
  let poolQuery: jest.Mock
  let release: jest.Mock
  let executor: MigrationExecutor

  function dropConnection(): void {
    connectionErrorListener?.(new Error('connection lost'))
  }

  function migration(id: string): Migration {
    return {
      id,
      run: jest.fn(async ({ database }) => {
        events.push(`run ${id}`)
        if (id === failingMigrationId) throw new Error(`${id} failed`)
        if (id === dropBeforeStatementMigrationId) dropConnection()
        await database.query(`statement ${id}`)
        if (id === dropAfterStatementMigrationId) dropConnection()
      })
    }
  }

  beforeEach(() => {
    events = []
    appliedMigrations = []
    lockAttempts = [true]
    failingMigrationId = undefined
    dropBeforeStatementMigrationId = undefined
    dropAfterStatementMigrationId = undefined
    dropAfterRecordMigrationId = undefined
    connectionErrorListener = undefined
    release = jest.fn()
    const client = {
      on: jest.fn((_event: string, listener: (error: Error) => void) => {
        connectionErrorListener = listener
      }),
      removeListener: jest.fn(),
      release,
      query: jest.fn(async (query: Query) => {
        const text = textOf(query)
        if (text.includes('pg_try_advisory_lock')) {
          const acquired = lockAttempts.shift() ?? true
          events.push(acquired ? 'lock' : 'lock busy')
          return { rows: [{ acquired }], rowCount: 1 }
        }
        if (text.includes('CREATE UNIQUE INDEX')) events.push('unique names')
        if (text.includes('DELETE FROM migrations')) events.push('dedupe')
        if (text.includes('SELECT name')) {
          events.push('read applied')
          return { rows: appliedMigrations.map((name) => ({ name })), rowCount: appliedMigrations.length }
        }
        if (text.includes('INSERT INTO migrations')) {
          const values = typeof query === 'string' ? [] : query.values
          events.push(`record ${values[0]}${text.includes('ON CONFLICT (name) DO NOTHING') ? ' once' : ''}`)
          if (values[0] === dropAfterRecordMigrationId) dropConnection()
        }
        if (text.startsWith('statement')) events.push(`session ${text}`)
        return { rows: [], rowCount: null }
      })
    }
    poolQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }))
    const database = {
      getPool: () => ({ connect: jest.fn(async () => client) }),
      query: poolQuery
    }
    const logs: ILoggerComponent = {
      getLogger: () => ({ log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
    }
    executor = createMigrationExecutor({ database, logs } as unknown as MigrationExecutorComponents, {
      migrations: [migration('0001'), migration('0002'), migration('0003')],
      lockRetryIntervalMs: 1
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the component starts', () => {
    describe('and some migrations were already applied', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001']
        await executor[START_COMPONENT]!({} as never)
      })

      it('should run and record only the pending migrations, in order, on the session holding the lock', () => {
        expect(events).toEqual([
          'lock',
          'dedupe',
          'unique names',
          'read applied',
          'run 0002',
          'session statement 0002',
          'record 0002 once',
          'run 0003',
          'session statement 0003',
          'record 0003 once'
        ])
      })

      it('should not run any statement through the shared pool', () => {
        expect(poolQuery).not.toHaveBeenCalled()
      })

      it('should destroy the lock connection so its session releases the lock', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })

    describe('and every migration was already applied', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001', '0002', '0003']
        await executor[START_COMPONENT]!({} as never)
      })

      it('should not run any migration', () => {
        expect(events).toEqual(['lock', 'dedupe', 'unique names', 'read applied'])
      })

      it('should destroy the lock connection so its session releases the lock', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })

    describe('and another instance holds the lock', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001', '0002']
        lockAttempts = [false, false, true]
        await executor[START_COMPONENT]!({} as never)
      })

      it('should wait until the lock is free before reading the applied migrations', () => {
        expect(events).toEqual([
          'lock busy',
          'lock busy',
          'lock',
          'dedupe',
          'unique names',
          'read applied',
          'run 0003',
          'session statement 0003',
          'record 0003 once'
        ])
      })
    })

    describe('and a migration fails', () => {
      let startError: unknown

      beforeEach(async () => {
        failingMigrationId = '0002'
        startError = await executor[START_COMPONENT]!({} as never).catch((error: unknown) => error)
      })

      it('should reject with the migration error', () => {
        expect(startError).toEqual(new Error('0002 failed'))
      })

      it('should stop without recording the failed migration', () => {
        expect(events.slice(-2)).toEqual(['record 0001 once', 'run 0002'])
      })

      it('should destroy the lock connection so its session releases the lock', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })

    describe('and the lock connection drops while a migration is running', () => {
      let startError: unknown

      beforeEach(async () => {
        dropBeforeStatementMigrationId = '0002'
        startError = await executor[START_COMPONENT]!({} as never).catch((error: unknown) => error)
      })

      it('should reject the migration statements issued after the drop', () => {
        expect(startError).toBeInstanceOf(MigrationsLockLostError)
      })

      it('should neither run those statements nor record the interrupted migration', () => {
        expect(events.slice(-3)).toEqual(['session statement 0001', 'record 0001 once', 'run 0002'])
      })

      it('should destroy the lock connection', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })

    describe('and the lock connection drops after a migration ran its statements', () => {
      let startError: unknown

      beforeEach(async () => {
        dropAfterStatementMigrationId = '0001'
        startError = await executor[START_COMPONENT]!({} as never).catch((error: unknown) => error)
      })

      it('should reject with the lock loss', () => {
        expect(startError).toBeInstanceOf(MigrationsLockLostError)
      })

      it('should neither record that migration nor run the next one', () => {
        expect(events.slice(-2)).toEqual(['run 0001', 'session statement 0001'])
      })
    })

    describe('and the lock connection drops between migrations', () => {
      let startError: unknown

      beforeEach(async () => {
        dropAfterRecordMigrationId = '0001'
        startError = await executor[START_COMPONENT]!({} as never).catch((error: unknown) => error)
      })

      it('should reject with the lock loss', () => {
        expect(startError).toBeInstanceOf(MigrationsLockLostError)
      })

      it('should not start the next migration', () => {
        expect(events.slice(-2)).toEqual(['session statement 0001', 'record 0001 once'])
      })
    })
  })
})
