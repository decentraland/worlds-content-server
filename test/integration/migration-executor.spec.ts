import { setTimeout as sleep } from 'timers/promises'
import { START_COMPONENT } from '@well-known-components/interfaces'
import SQL from 'sql-template-strings'
import { test } from '../components'
import { createMigrationExecutor } from '../../src/adapters/migration-executor'
import { Migration } from '../../src/types'

const TABLE_MIGRATION = 'test_concurrent_startup_table'
const INDEX_MIGRATION = 'test_concurrent_startup_index'

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
