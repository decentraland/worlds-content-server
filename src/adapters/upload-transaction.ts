import SQL, { SQLStatement } from 'sql-template-strings'
import { IPgComponent } from '@dcl/pg-component'
import { connectWithSignal } from './pg-client'

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
  const client = await connectWithSignal(database.getPool(), signal)
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
