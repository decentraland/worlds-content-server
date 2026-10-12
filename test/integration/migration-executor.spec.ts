import { setTimeout as sleep } from 'timers/promises'
import { START_COMPONENT } from '@well-known-components/interfaces'
import SQL from 'sql-template-strings'
import { test } from '../components'
import { createMigrationExecutor, MigrationsLockLostError } from '../../src/adapters/migration-executor'
import { Migration } from '../../src/types'

const TABLE_MIGRATION = 'test_concurrent_startup_table'
const INDEX_MIGRATION = 'test_concurrent_startup_index'
const LOCK_LOSS_MIGRATION = 'test_lock_loss_table'
const TRANSACTION_MIGRATION = 'test_transaction_table'

test('MigrationExecutor', function ({ components }) {
  describe('when two instances start at the same time', () => {
    let runs: Record<string, number>
    let results: PromiseSettledResult<void>[]
    let recordedNames: string[]
    let indexIsValid: boolean

    beforeEach(async () => {
      const { database } = components
      runs = { [TABLE_MIGRATION]: 0, [INDEX_MIGRATION]: 0 }
      const migrations: Migration[] = [
        {
          id: TABLE_MIGRATION,
          run: async ({ database }) => {
            runs[TABLE_MIGRATION]++
            await database.query('CREATE TABLE test_concurrent_startup (id SERIAL PRIMARY KEY, value INT)')
            // Keeps the lock held long enough for the other instance to be waiting on it.
            await sleep(500)
          }
        },
        {
          id: INDEX_MIGRATION,
          run: async ({ database }) => {
            runs[INDEX_MIGRATION]++
            await database.query(
              'CREATE INDEX CONCURRENTLY test_concurrent_startup_value_idx ON test_concurrent_startup (value)'
            )
          }
        }
      ]
      const executors = [0, 1].map(() => createMigrationExecutor(components, { migrations, lockRetryIntervalMs: 50 }))
      results = await Promise.allSettled(executors.map((executor) => executor[START_COMPONENT]!({} as never)))
      const recorded = await database.query<{ name: string }>(
        SQL`SELECT name FROM migrations WHERE name IN (${TABLE_MIGRATION}, ${INDEX_MIGRATION}) ORDER BY id`
      )
      recordedNames = recorded.rows.map((row) => row.name)
      const index = await database.query<{ indisvalid: boolean }>(`
        SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'test_concurrent_startup_value_idx'
      `)
      indexIsValid = index.rows[0]?.indisvalid ?? false
    }, 30_000)

    afterEach(async () => {
      await components.database.query('DROP TABLE IF EXISTS test_concurrent_startup')
      await components.database.query(
        SQL`DELETE FROM migrations WHERE name IN (${TABLE_MIGRATION}, ${INDEX_MIGRATION})`
      )
    })

    it('should start both instances successfully', () => {
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    })

    it('should run each migration exactly once', () => {
      expect(runs).toEqual({ [TABLE_MIGRATION]: 1, [INDEX_MIGRATION]: 1 })
    })

    it('should record each migration exactly once', () => {
      expect(recordedNames).toEqual([TABLE_MIGRATION, INDEX_MIGRATION])
    })

    it('should build the concurrent index while the other instance waits', () => {
      expect(indexIsValid).toBe(true)
    })
  })

  describe('when the lock session is terminated while a migration is running', () => {
    let runs: number
    let firstStartError: unknown
    let tableExistedAfterLockLoss: boolean
    let recordedAfterLockLoss: number
    let secondStartResult: PromiseSettledResult<void>
    let recordedNames: string[]
    let tableExists: boolean

    async function tableIsPresent(): Promise<boolean> {
      const result = await components.database.query(`SELECT to_regclass('test_lock_loss') IS NOT NULL AS present`)
      return result.rows[0].present
    }

    beforeEach(async () => {
      const { database } = components
      runs = 0
      const migrations: Migration[] = [
        {
          id: LOCK_LOSS_MIGRATION,
          run: async ({ database: session }) => {
            runs++
            if (runs === 1) {
              const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
              await database.query(SQL`SELECT pg_terminate_backend(${rows[0].pid})`)
              // Lets the terminated session's error reach the client before the next statement.
              await sleep(300)
            }
            await session.query('CREATE TABLE test_lock_loss (id INT)')
          }
        }
      ]
      firstStartError = await createMigrationExecutor(components, { migrations })[START_COMPONENT]!({} as never).catch(
        (error: unknown) => error
      )
      tableExistedAfterLockLoss = await tableIsPresent()
      const recorded = await database.query(SQL`SELECT 1 FROM migrations WHERE name = ${LOCK_LOSS_MIGRATION}`)
      recordedAfterLockLoss = recorded.rowCount
      ;[secondStartResult] = await Promise.allSettled([
        createMigrationExecutor(components, { migrations, lockRetryIntervalMs: 50 })[START_COMPONENT]!({} as never)
      ])
      const recordedAgain = await database.query<{ name: string }>(
        SQL`SELECT name FROM migrations WHERE name = ${LOCK_LOSS_MIGRATION}`
      )
      recordedNames = recordedAgain.rows.map((row) => row.name)
      tableExists = await tableIsPresent()
    }, 30_000)

    afterEach(async () => {
      await components.database.query('DROP TABLE IF EXISTS test_lock_loss')
      await components.database.query(SQL`DELETE FROM migrations WHERE name = ${LOCK_LOSS_MIGRATION}`)
    })

    it('should fail the startup with the lock loss', () => {
      expect(firstStartError).toBeInstanceOf(MigrationsLockLostError)
    })

    it('should not run the migration statements issued after the lock was lost', () => {
      expect(tableExistedAfterLockLoss).toBe(false)
    })

    it('should not record the interrupted migration', () => {
      expect(recordedAfterLockLoss).toBe(0)
    })

    it('should let the next instance take the lock and run the migration once', () => {
      expect({ status: secondStartResult.status, runs, recordedNames, tableExists }).toEqual({
        status: 'fulfilled',
        runs: 2,
        recordedNames: [LOCK_LOSS_MIGRATION],
        tableExists: true
      })
    })
  })

  describe('when a migration runs its own transaction', () => {
    let visibleBeforeCommit: boolean
    let visibleAfterCommit: boolean

    beforeEach(async () => {
      const { database } = components
      const isVisible = async (): Promise<boolean> => {
        const result = await database.query(`SELECT to_regclass('test_transaction') IS NOT NULL AS present`)
        return result.rows[0].present
      }
      const migrations: Migration[] = [
        {
          id: TRANSACTION_MIGRATION,
          run: async ({ database: session }) => {
            await session.query('BEGIN')
            await session.query('CREATE TABLE test_transaction (id INT)')
            visibleBeforeCommit = await isVisible()
            await session.query('COMMIT')
          }
        }
      ]
      await createMigrationExecutor(components, { migrations })[START_COMPONENT]!({} as never)
      visibleAfterCommit = await isVisible()
    })

    afterEach(async () => {
      await components.database.query('DROP TABLE IF EXISTS test_transaction')
      await components.database.query(SQL`DELETE FROM migrations WHERE name = ${TRANSACTION_MIGRATION}`)
    })

    it('should keep its statements in that transaction until it commits', () => {
      expect({ visibleBeforeCommit, visibleAfterCommit }).toEqual({
        visibleBeforeCommit: false,
        visibleAfterCommit: true
      })
    })
  })

  describe('when the migrations table holds duplicate records from past races', () => {
    let recordedNames: string[]
    let uniqueIndexExists: boolean

    beforeEach(async () => {
      const { database } = components
      await database.query('DROP INDEX IF EXISTS migrations_name_key')
      await database.query(SQL`
        INSERT INTO migrations (name, run_on)
        VALUES (${TABLE_MIGRATION}, ${new Date()}), (${TABLE_MIGRATION}, ${new Date()})
      `)
      const migrations: Migration[] = [{ id: TABLE_MIGRATION, run: jest.fn() }]
      await createMigrationExecutor(components, { migrations })[START_COMPONENT]!({} as never)
      const recorded = await database.query<{ name: string }>(
        SQL`SELECT name FROM migrations WHERE name = ${TABLE_MIGRATION}`
      )
      recordedNames = recorded.rows.map((row) => row.name)
      const index = await database.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'migrations_name_key'`)
      uniqueIndexExists = index.rowCount === 1
    })

    afterEach(async () => {
      await components.database.query(SQL`DELETE FROM migrations WHERE name = ${TABLE_MIGRATION}`)
    })

    it('should keep a single record per migration', () => {
      expect(recordedNames).toEqual([TABLE_MIGRATION])
    })

    it('should enforce unique migration names', () => {
      expect(uniqueIndexExists).toBe(true)
    })
  })
})
