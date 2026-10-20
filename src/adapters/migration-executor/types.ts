import { IBaseComponent } from '@well-known-components/interfaces'
import { SQLStatement } from 'sql-template-strings'
import { AppComponents, Migration, MigratorComponents } from '../../types'

/** The database handle migrations receive: bound to the session that holds the migrations lock. */
export type MigrationDatabase = {
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string | SQLStatement
  ): Promise<{ rows: T[]; rowCount: number }>
}

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
