import { Migration, MigratorComponents } from '../types'
import { IBaseComponent, START_COMPONENT } from '@well-known-components/interfaces'
import SQL from 'sql-template-strings'
import { allMigrations } from '../migrations/all-migrations'

/**
 * Applies pending migrations when started. Lifecycle starts components one at a time in their
 * declaration order, so every component declared after this one (the HTTP server, consumers and jobs)
 * only starts once the schema is current.
 */
export type MigrationExecutor = IBaseComponent

export function createMigrationExecutor(components: MigratorComponents): MigrationExecutor {
  const { logs } = components
  const logger = logs.getLogger('migration-executor')

  async function getPendingMigrations(): Promise<Migration[]> {
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
    const alreadyRunMigrations = new Set(result.rows.map((row) => row.name))
    return allMigrations.filter((migration) => !alreadyRunMigrations.has(migration.id))
  }

  async function start(): Promise<void> {
    const pendingMigrations = await getPendingMigrations()
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
    [START_COMPONENT]: start
  }
}
