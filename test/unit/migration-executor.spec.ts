import { ILoggerComponent, START_COMPONENT } from '@well-known-components/interfaces'
import { createMigrationExecutor, MigrationExecutor } from '../../src/adapters/migration-executor'
import { Migration, MigratorComponents } from '../../src/types'

type Query = string | { text: string; values: unknown[] }

function textOf(query: Query): string {
  return typeof query === 'string' ? query : query.text
}

describe('MigrationExecutor', () => {
  let events: string[]
  let appliedMigrations: string[]
  let lockAttempts: boolean[]
  let failingMigrationId: string | undefined
  let unlockError: Error | undefined
  let connectionDropMigrationId: string | undefined
  let connectionErrorListener: ((error: Error) => void) | undefined
  let release: jest.Mock
  let executor: MigrationExecutor

  function migration(id: string): Migration {
    return {
      id,
      run: jest.fn(async () => {
        events.push(`run ${id}`)
        if (id === failingMigrationId) throw new Error(`${id} failed`)
        if (id === connectionDropMigrationId) connectionErrorListener?.(new Error('connection lost'))
      })
    }
  }

  beforeEach(() => {
    events = []
    appliedMigrations = []
    lockAttempts = [true]
    failingMigrationId = undefined
    unlockError = undefined
    connectionDropMigrationId = undefined
    connectionErrorListener = undefined
    const client = {
      on: jest.fn((_event: string, listener: (error: Error) => void) => {
        connectionErrorListener = listener
      }),
      removeListener: jest.fn(),
      query: jest.fn(async (query: Query) => {
        const text = textOf(query)
        if (text.includes('pg_try_advisory_lock')) {
          const acquired = lockAttempts.shift() ?? true
          events.push(acquired ? 'lock' : 'lock busy')
          return { rows: [{ acquired }] }
        }
        if (text.includes('pg_advisory_unlock')) {
          events.push('unlock')
          if (unlockError) throw unlockError
        }
        return { rows: [] }
      })
    }
    release = jest.fn()
    const database = {
      getPool: () => ({ connect: jest.fn(async () => ({ ...client, release })) }),
      query: jest.fn(async (query: Query) => {
        const text = textOf(query)
        if (text.includes('CREATE UNIQUE INDEX')) events.push('unique names')
        if (text.includes('DELETE FROM migrations')) events.push('dedupe')
        if (text.includes('SELECT name')) {
          events.push('read applied')
          return { rows: appliedMigrations.map((name) => ({ name })) }
        }
        if (text.includes('INSERT INTO migrations')) {
          const values = typeof query === 'string' ? [] : query.values
          events.push(`record ${values[0]}${text.includes('ON CONFLICT (name) DO NOTHING') ? ' once' : ''}`)
        }
        return { rows: [] }
      })
    }
    const logs: ILoggerComponent = {
      getLogger: () => ({ log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
    }
    executor = createMigrationExecutor({ database, logs } as unknown as MigratorComponents, {
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

      it('should run and record only the pending migrations, in order, while holding the lock', () => {
        expect(events).toEqual([
          'lock',
          'dedupe',
          'unique names',
          'read applied',
          'run 0002',
          'record 0002 once',
          'run 0003',
          'record 0003 once',
          'unlock'
        ])
      })

      it('should return the lock connection to the pool', () => {
        expect(release).toHaveBeenCalledWith(false)
      })
    })

    describe('and every migration was already applied', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001', '0002', '0003']
        await executor[START_COMPONENT]!({} as never)
      })

      it('should not run any migration and release the lock', () => {
        expect(events).toEqual(['lock', 'dedupe', 'unique names', 'read applied', 'unlock'])
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
          'record 0003 once',
          'unlock'
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

      it('should release the lock without recording the failed migration', () => {
        expect(events.slice(-3)).toEqual(['record 0001 once', 'run 0002', 'unlock'])
      })
    })

    describe('and the lock connection drops during a migration', () => {
      let startError: unknown

      beforeEach(async () => {
        connectionDropMigrationId = '0001'
        startError = await executor[START_COMPONENT]!({} as never).catch((error: unknown) => error)
      })

      it('should reject without running the next migration', () => {
        expect(startError).toEqual(new Error('Lost the migrations lock, stopping before the next migration'))
      })

      it('should record the migration that completed and stop there', () => {
        expect(events.slice(-3)).toEqual(['run 0001', 'record 0001 once', 'unlock'])
      })

      it('should discard the lock connection', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })

    describe('and the lock cannot be released', () => {
      beforeEach(async () => {
        unlockError = new Error('connection lost')
        await executor[START_COMPONENT]!({} as never)
      })

      it('should discard the lock connection so its session releases the lock', () => {
        expect(release).toHaveBeenCalledWith(true)
      })
    })
  })
})
