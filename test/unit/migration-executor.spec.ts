import { ILoggerComponent, START_COMPONENT } from '@well-known-components/interfaces'
import { createMigrationExecutor, MigrationExecutor } from '../../src/adapters/migration-executor'
import { allMigrations } from '../../src/migrations/all-migrations'
import { Migration, MigratorComponents } from '../../src/types'

jest.mock('../../src/migrations/all-migrations', () => ({ allMigrations: [] }))

describe('MigrationExecutor', () => {
  let events: string[]
  let appliedMigrations: string[]
  let executor: MigrationExecutor

  function migration(id: string): Migration {
    return { id, run: jest.fn(async () => void events.push(`run ${id}`)) }
  }

  beforeEach(() => {
    events = []
    const database = {
      query: jest.fn(async (query: string | { text: string; values: unknown[] }) => {
        const text = typeof query === 'string' ? query : query.text
        if (text.includes('SELECT name')) return { rows: appliedMigrations.map((name) => ({ name })) }
        if (typeof query !== 'string' && text.includes('INSERT INTO migrations'))
          events.push(`record ${query.values[0]}`)
        return { rows: [] }
      })
    }
    const logs: ILoggerComponent = {
      getLogger: () => ({ log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
    }
    allMigrations.splice(0, allMigrations.length, migration('0001'), migration('0002'), migration('0003'))
    executor = createMigrationExecutor({ database, logs } as unknown as MigratorComponents)
  })

  describe('when the component starts', () => {
    describe('and some migrations were already applied', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001']
        await executor[START_COMPONENT]!({} as never)
      })

      it('should run and record only the pending migrations, in order', () => {
        expect(events).toEqual(['run 0002', 'record 0002', 'run 0003', 'record 0003'])
      })
    })

    describe('and every migration was already applied', () => {
      beforeEach(async () => {
        appliedMigrations = ['0001', '0002', '0003']
        await executor[START_COMPONENT]!({} as never)
      })

      it('should not run any migration', () => {
        expect(events).toEqual([])
      })
    })
  })
})
