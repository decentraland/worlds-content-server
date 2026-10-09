import { setTimeout as sleep } from 'timers/promises'
import { IBaseComponent, START_COMPONENT } from '@well-known-components/interfaces'
import SQL, { SQLStatement } from 'sql-template-strings'
import { AppComponents, Migration, MigrationDatabase, MigratorComponents } from '../types'
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

/** Components the executor needs: the pool to check out its session plus what migrations receive. */
export type MigrationExecutorComponents = Pick<AppComponents, 'database'> & Omit<MigratorComponents, 'database'>

/** Thrown once the session holding the migrations lock is gone, so no further migration SQL runs unlocked. */
export class MigrationsLockLostError extends Error {
  constructor() {
    super('Lost the migrations lock, stopping migrations')
    this.name = 'MigrationsLockLostError'
  }
}

/**
 * Creates the migration executor. Instances sharing a database serialize on a session-level advisory
 * lock, and every migration statement (and its record) runs on that same session: if the session dies
 * the lock and the in-flight migration die together, so no two instances ever run migration SQL at once.
 * @param components Pool, logs and the components migrations receive.
 * @param options Migration list and lock polling interval.
 * @returns The lifecycle component that migrates on start.
 */
export function createMigrationExecutor(
  components: MigrationExecutorComponents,
  options: MigrationExecutorOptions = {}
): MigrationExecutor {
  const { config, database, logs, nameOwnership, storage } = components
  const migrations = options.migrations ?? allMigrations
  const lockRetryIntervalMs = options.lockRetryIntervalMs ?? LOCK_RETRY_INTERVAL_MS
  const logger = logs.getLogger('migration-executor')

  // Polls instead of blocking in pg_advisory_lock: a blocked statement holds a snapshot, and
  // CREATE INDEX CONCURRENTLY run by the lock holder would wait on it forever.
  async function acquireLock(session: MigrationDatabase): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const result = await session.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${MIGRATIONS_LOCK_KEY}) AS acquired`
      )
      if (result.rows[0]?.acquired) return
      if (attempt === 0) logger.info('Another instance is running migrations, waiting for it to finish')
      await sleep(lockRetryIntervalMs)
    }
  }

  async function prepareMigrationsTable(session: MigrationDatabase): Promise<void> {
    await session.query(SQL`
        CREATE TABLE IF NOT EXISTS migrations
        (
            id     SERIAL PRIMARY KEY,
            name   VARCHAR(255) NOT NULL,
            run_on TIMESTAMP    NOT NULL
        );
    `)
    // Unlocked executors of older versions could record a migration twice: keep the earliest record.
    await session.query(SQL`DELETE FROM migrations a USING migrations b WHERE a.name = b.name AND a.id > b.id`)
    await session.query(SQL`CREATE UNIQUE INDEX IF NOT EXISTS migrations_name_key ON migrations (name)`)
  }

  async function getPendingMigrations(session: MigrationDatabase): Promise<Migration[]> {
    const result = await session.query<{ name: string }>(SQL`SELECT name FROM migrations`)
    const alreadyRunMigrations = new Set(result.rows.map((row) => row.name))
    return migrations.filter((migration) => !alreadyRunMigrations.has(migration.id))
  }

  async function runPendingMigrations(session: MigrationDatabase, lockLost: () => boolean): Promise<void> {
    await prepareMigrationsTable(session)
    const pendingMigrations = await getPendingMigrations(session)
    if (pendingMigrations.length === 0) {
      logger.debug('Migrations are up to date, nothing to run')
      return
    }

    const migrationComponents: MigratorComponents = { config, database: session, logs, nameOwnership, storage }
    logger.debug('Running pending migrations')
    for (const migration of pendingMigrations) {
      if (lockLost()) throw new MigrationsLockLostError()
      logger.info(`Running migration ${migration.id}`)
      await migration.run(migrationComponents)
      await session.query(
        SQL`INSERT INTO migrations (name, run_on) VALUES (${migration.id}, ${new Date()}) ON CONFLICT (name) DO NOTHING`
      )
      logger.info(`Migration ${migration.id} run successfully`)
    }
  }

  async function start(): Promise<void> {
    const client: UploadClient = await database.getPool().connect()
    let lockLost = false
    // Stays attached until the connection is destroyed: an unhandled 'error' event would crash the process.
    client.on('error', (error: Error) => {
      lockLost = true
      logger.warn(`The migrations lock connection failed: ${error.message}`)
    })
    const session: MigrationDatabase = {
      async query<T extends Record<string, any>>(sql: string | SQLStatement) {
        if (lockLost) throw new MigrationsLockLostError()
        const result = await client.query<T>(sql)
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      }
    }
    try {
      await acquireLock(session)
      await runPendingMigrations(session, () => lockLost)
    } finally {
      // Ending the session releases the lock and discards whatever a migration left on it
      // (session settings, an unfinished transaction) instead of handing it to the application.
      client.release(true)
    }
  }

  return {
    [START_COMPONENT]: start
  }
}
