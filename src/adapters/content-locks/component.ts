import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { createPgComponent } from '@dcl/pg-component'
import SQL from 'sql-template-strings'
import { AppComponents } from '../../types'
import { getPositiveInteger, raceWithSignal } from '../../logic/concurrency'
import { UploadClient } from '../upload-transaction'
import { IContentLocks } from './types'

/**
 * Creates a distributed storage/GC gate on a separate WKC connection pool. Uploads share the gate;
 * deletion takes it exclusively. Never release a held lock until its storage operations settle.
 * @param components Configuration, logging and metrics for the dedicated lock pool.
 * @returns Lifecycle-managed content locks shared by all instances using this database.
 */
export async function createContentLocks(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>
): Promise<IContentLocks> {
  const max = await getPositiveInteger(components.config, 'CONTENT_LOCK_CONNECTIONS', 16)
  const pg = await createPgComponent(components, { pool: { max, connectionTimeoutMillis: 10_000 } })

  async function run<T>(
    exclusive: boolean,
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    entityId?: string
  ): Promise<T> {
    signal?.throwIfAborted()
    const acquisition: Promise<UploadClient> = pg.getPool().connect()
    const client = await raceWithSignal(acquisition, signal).catch((error: unknown) => {
      void acquisition.then(
        (lateClient) => lateClient.release(),
        () => undefined
      )
      throw error
    })
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    const connectionError = (error: Error): void => controller.abort(error)
    signal?.addEventListener('abort', abort, { once: true })
    client.on('error', connectionError)
    let failed = false
    try {
      if (signal?.aborted) abort()
      const query = exclusive
        ? SQL`SELECT pg_advisory_lock(hashtextextended('worlds-content-gc', 0))`
        : SQL`SELECT pg_advisory_lock_shared(hashtextextended('worlds-content-gc', 0))`
      await raceWithSignal(client.query(query), controller.signal)
      if (entityId) {
        await raceWithSignal(
          client.query(SQL`SELECT pg_advisory_lock(hashtextextended(${'partial-entity:' + entityId}, 0))`),
          controller.signal
        )
      }
      controller.signal.throwIfAborted()
      return await operation(controller.signal)
    } catch (error) {
      failed = true
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      // Destroy a connection with a queued acquisition or broken transport. A successful operation
      // unlocks explicitly, allowing the lock pool to reuse its connection without session leaks.
      if (!failed) {
        try {
          await client.query('SELECT pg_advisory_unlock_all()')
        } catch {
          failed = true
        }
      }
      client.removeListener('error', connectionError)
      client.release(failed)
    }
  }

  return {
    [START_COMPONENT]: () => pg.start(),
    [STOP_COMPONENT]: () => pg.stop(),
    withRead: (operation, signal, entityId) => run(false, operation, signal, entityId),
    withWrite: (operation) => run(true, operation)
  }
}
