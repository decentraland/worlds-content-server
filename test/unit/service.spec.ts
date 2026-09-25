import { ILoggerComponent, IBaseComponent, Lifecycle, START_COMPONENT } from '@well-known-components/interfaces'
import { createMigrationExecutor } from '../../src/adapters/migration-executor'
import { allMigrations } from '../../src/migrations/all-migrations'
import { main } from '../../src/service'
import { AppComponents, MigratorComponents } from '../../src/types'

jest.mock('../../src/migrations/all-migrations', () => ({ allMigrations: [] }))
jest.mock('../../src/controllers/routes', () => ({
  setupRouter: jest.fn(async () => ({ middleware: () => jest.fn(), allowedMethods: () => jest.fn() }))
}))

describe('when the service starts', () => {
  let events: string[]
  let program: Lifecycle.ComponentBasedProgram<AppComponents>

  beforeEach(async () => {
    events = []
    const logs: ILoggerComponent = {
      getLogger: () => ({ log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
    }
    const database = {
      query: jest.fn(async () => ({ rows: [] })),
      [START_COMPONENT]: jest.fn(async () => void events.push('database started'))
    }
    allMigrations.splice(0, allMigrations.length, {
      id: '0001',
      // Yields before finishing so a server started concurrently would be observed first.
      run: async () => {
        await new Promise((resolve) => setImmediate(resolve))
        events.push('migration applied')
      }
    })
    const migrationExecutor = createMigrationExecutor({ database, logs } as unknown as MigratorComponents)
    const server: IBaseComponent & { use: jest.Mock; setContext: jest.Mock } = {
      use: jest.fn(),
      setContext: jest.fn(),
      [START_COMPONENT]: jest.fn(async () => void events.push('server started'))
    }
    program = await Lifecycle.run<AppComponents>({
      main,
      initComponents: async () => ({ database, migrationExecutor, server }) as unknown as AppComponents
    })
  })

  afterEach(async () => {
    await program.stop()
  })

  it('should apply pending migrations before the server starts serving', () => {
    expect(events).toEqual(['database started', 'migration applied', 'server started'])
  })
})
