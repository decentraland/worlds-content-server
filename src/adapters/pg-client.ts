import { SQLStatement } from 'sql-template-strings'
import { raceWithSignal } from '../logic/concurrency'

/** A connection checked out of a node-postgres pool, narrowed to what callers use. */
export type PgClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string | SQLStatement
  ): Promise<{ rows: T[]; rowCount: number | null }>
  /** Returns the connection to the pool; `true` or an error destroys it instead. */
  release(destroy?: boolean | Error): void
  on(event: 'error', listener: (error: Error) => void): void
  removeListener(event: 'error', listener: (error: Error) => void): void
}

/**
 * Checks out a pool connection unless the signal aborts first. A connection that arrives after the
 * abort is released back to the pool instead of leaking.
 * @param pool Pool to check the connection out of.
 * @param signal Optional cancellation signal.
 * @returns The checked-out connection; the caller must release it.
 * @throws The abort reason when cancelled, or the pool's connection error.
 */
export async function connectWithSignal(
  pool: { connect(): Promise<PgClient> },
  signal?: AbortSignal
): Promise<PgClient> {
  signal?.throwIfAborted()
  const acquisition = pool.connect()
  try {
    return await raceWithSignal(acquisition, signal)
  } catch (error) {
    void acquisition.then(
      (lateClient) => lateClient.release(),
      () => undefined
    )
    throw error
  }
}
