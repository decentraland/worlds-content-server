import SQL, { SQLStatement } from 'sql-template-strings'
import { IPgComponent } from '@dcl/pg-component'
import { raceWithSignal } from '../logic/concurrency'

export type UploadClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string | SQLStatement
  ): Promise<{ rows: T[]; rowCount: number | null }>
  release(destroy?: boolean): void
  on(event: 'error', listener: (error: Error) => void): void
  removeListener(event: 'error', listener: (error: Error) => void): void
}

type Query = <T extends Record<string, unknown>>(sql: SQLStatement) => Promise<{ rows: T[]; rowCount: number | null }>

/**
 * Executes short staging mutations atomically, destroying the checked-out connection on cancellation.
 * @param database Shared application pool.
 * @param operation Sequential SQL work on one connection.
 * @param signal Request deadline/disconnect signal.
 * @returns The committed operation result.
 */
export async function withUploadTransaction<T>(
  database: IPgComponent,
  operation: (query: Query) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  const acquisition: Promise<UploadClient> = database.getPool().connect()
  const client = await raceWithSignal(acquisition, signal).catch((error: unknown) => {
    void acquisition.then(
      (lateClient) => lateClient.release(),
      () => undefined
    )
    throw error
  })
  let released = false
  const abort = (): void => {
    if (!released) {
      released = true
      client.release(true)
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    await client.query('BEGIN')
    await client.query(SQL`SELECT set_config('statement_timeout', '30000', true)`)
    const result = await operation(async <R extends Record<string, unknown>>(sql: SQLStatement) => {
      signal?.throwIfAborted()
      const response = await client.query<R>(sql)
      signal?.throwIfAborted()
      return response
    })
    signal?.throwIfAborted()
    signal?.removeEventListener('abort', abort)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (!released) {
      await client.query('ROLLBACK').catch(() => {
        released = true
        client.release(true)
      })
    }
    if (signal?.aborted) throw signal.reason
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!released) client.release()
  }
}
