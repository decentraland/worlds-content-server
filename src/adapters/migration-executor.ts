import { Migration, MigratorComponents } from '../types'
import { IBaseComponent } from '@well-known-components/interfaces/dist/components/base-component'
import SQL from 'sql-template-strings'
import { allMigrations } from '../migrations/all-migrations'

export interface MigrationExecutor {
  run: () => Promise<void>
}

export function createMigrationExecutor(components: MigratorComponents): MigrationExecutor & IBaseComponent {
  const { logs } = components
  const logger = logs.getLogger('migration-executor')

  const alreadyRunMigrations: string[] = []
  const pendingMigrations: Migration[] = []

  async function start(): Promise<void> {
    // Create the migrations table if it does not exist
    await components.database.query(SQL`
        CREATE TABLE IF NOT EXISTS migrations
        (
            id     SERIAL PRIMARY KEY,
            name   VARCHAR(255) NOT NULL,
            run_on TIMESTAMP    NOT NULL
        );
    `)

    // Query what migrations have already been run
    const result = await components.database.query<{ name: string; run_on: Date }>(
      'SELECT name, run_on from migrations'
    )
    alreadyRunMigrations.push(...result.rows.map((row) => row.name))

    // Determine pending migrations
    pendingMigrations.push(...allMigrations.filter((migration) => !alreadyRunMigrations.includes(migration.id)))

    // TODO Run startup checks, like:
    // 1. Check the migration table exists and if not, create it.
    // 2. Check all existing migrations are known in code.
    // 3. Check all code migration and existing migrations are order correctly time.
    console.log('alreadyRunMigrations', alreadyRunMigrations)
    console.log(
      'existingCodeMigrations',
      allMigrations.map((m) => m.id)
    )
    console.log(
      'pendingMigrations',
      pendingMigrations.map((m) => m.id)
    )
  }

  async function run(): Promise<void> {
    logger.debug('Running pending migrations')
    for (const migration of pendingMigrations) {
      logger.info(`running migration ${migration.id}`)
      await migration.run(components)
      await components.database.query(
        SQL`INSERT INTO migrations (name, run_on) VALUES (${migration.id}, ${new Date()})`
      )
      logger.info(`migration ${migration.id} run successfully`)
    }
  }

  return {
    start,
    run
  }
}
