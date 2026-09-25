import { setTimeout as sleep } from 'timers/promises'
import { IBaseComponent, START_COMPONENT } from '@well-known-components/interfaces'
import SQL from 'sql-template-strings'
import { Migration, MigratorComponents } from '../types'
import { allMigrations } from '../migrations/all-migrations'
import { UploadClient } from './upload-transaction'

const MIGRATIONS_LOCK_KEY = "hashtextextended('worlds-content-server:migrations', 0)"
const LOCK_RETRY_INTERVAL_MS = 1_000

/**
 * Applies pending migrations when started. Lifecycle starts components one at a time in their
 * declaration order, so every component declared after this one (the HTTP server, consumers and jobs)
 * only starts once the schema is current.
 */
export type MigrationExecutor = IBaseComponent

export type MigrationExecutorOptions = {
  /** Migrations to apply, in order. Defaults to every migration in the codebase. */
  migrations?: Migration[]
  /** Pause between attempts to take the lock while another instance is migrating. */
  lockRetryIntervalMs?: number
}

/**
 * Creates the migration executor. Instances sharing a database serialize on a session-level advisory
 * lock held on a dedicated connection, so each migration runs and is recorded exactly once.
 * @param components Database, logs and the components migrations receive.
 * @param options Migration list and lock polling interval.
 * @returns The lifecycle component that migrates on start.
 */
export function createMigrationExecutor(
  components: MigratorComponents,
  options: MigrationExecutorOptions = {}
): MigrationExecutor {
  const { database, logs } = components
  const migrations = options.migrations ?? allMigrations
  const lockRetryIntervalMs = options.lockRetryIntervalMs ?? LOCK_RETRY_INTERVAL_MS
  const logger = logs.getLogger('migration-executor')

  // Polls instead of blocking in pg_advisory_lock: a blocked statement holds a snapshot, and
  // CREATE INDEX CONCURRENTLY run by the lock holder would wait on it forever.
  async function acquireLock(client: UploadClient): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${MIGRATIONS_LOCK_KEY}) AS acquired`
      )
      if (result.rows[0]?.acquired) return
      if (attempt === 0) logger.info('Another instance is running migrations, waiting for it to finish')
      await sleep(lockRetryIntervalMs)
    }
  }

  async function prepareMigrationsTable(): Promise<void> {
    await database.query(SQL`
        CREATE TABLE IF NOT EXISTS migrations
        (
            id     SERIAL PRIMARY KEY,
            name   VARCHAR(255) NOT NULL,
            run_on TIMESTAMP    NOT NULL
        );
    `)
    // Unlocked executors of older versions could record a migration twice: keep the earliest record.
    await database.query(SQL`DELETE FROM migrations a USING migrations b WHERE a.name = b.name AND a.id > b.id`)
    await database.query(SQL`CREATE UNIQUE INDEX IF NOT EXISTS migrations_name_key ON migrations (name)`)
  }

  async function getPendingMigrations(): Promise<Migration[]> {
    const result = await database.query<{ name: string }>(SQL`SELECT name FROM migrations`)
    const alreadyRunMigrations = new Set(result.rows.map((row) => row.name))
    return migrations.filter((migration) => !alreadyRunMigrations.has(migration.id))
  }

  async function runPendingMigrations(lockLost: () => boolean): Promise<void> {
    await prepareMigrationsTable()
    const pendingMigrations = await getPendingMigrations()
    if (pendingMigrations.length === 0) {
      logger.debug('Migrations are up to date, nothing to run')
      return
    }

    logger.debug('Running pending migrations')
    for (const migration of pendingMigrations) {
      if (lockLost()) throw new Error('Lost the migrations lock, stopping before the next migration')
      logger.info(`Running migration ${migration.id}`)
      await migration.run(components)
      await database.query(
        SQL`INSERT INTO migrations (name, run_on) VALUES (${migration.id}, ${new Date()}) ON CONFLICT (name) DO NOTHING`
      )
      logger.info(`Migration ${migration.id} run successfully`)
    }
  }

  async function start(): Promise<void> {
    // Migrations use the pool; this connection only holds the lock and stays idle outside a transaction.
    const client: UploadClient = await database.getPool().connect()
    let reusable = true
    // A dropped lock connection frees the lock: stop migrating instead of crashing on the unhandled error.
    const onConnectionError = (error: Error): void => {
      reusable = false
      logger.warn(`The migrations lock connection failed: ${error.message}`)
    }
    client.on('error', onConnectionError)
    try {
      try {
        await acquireLock(client)
      } catch (error) {
        reusable = false
        throw error
      }
      try {
        await runPendingMigrations(() => !reusable)
      } finally {
        try {
          await client.query(`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`)
        } catch (error) {
          // Discarding the connection ends its session, which releases the lock.
          reusable = false
          logger.warn(`Could not release the migrations lock: ${(error as Error).message}`)
        }
      }
    } finally {
      client.removeListener('error', onConnectionError)
      client.release(!reusable)
    }
  }

  return {
    [START_COMPONENT]: start
  }
}
