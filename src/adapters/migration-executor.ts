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
  }

  async function run(): Promise<void> {
    if (pendingMigrations.length === 0) {
      logger.debug('Migrations are up to date, nothing to run')
      return
    }

    logger.debug('Running pending migrations')
    for (const migration of pendingMigrations) {
      logger.info(`Running migration ${migration.id}`)
      await migration.run(components)
      await components.database.query(
        SQL`INSERT INTO migrations (name, run_on) VALUES (${migration.id}, ${new Date()})`
      )
      logger.info(`Migration ${migration.id} run successfully`)
    }
  }

  return {
    start,
    run
  }
}
