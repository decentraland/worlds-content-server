import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { createPgComponent } from '@dcl/pg-component'
import SQL, { SQLStatement } from 'sql-template-strings'
import { AppComponents } from '../../types'
import { getPositiveInteger, raceWithSignal } from '../../logic/concurrency'
import { UploadClient } from '../upload-transaction'
import { ContentLockTimeoutError } from './errors'
import { ContentLocksOptions, IContentLocks } from './types'

// Backoff while GC or another request holds a lock; the request's own deadline bounds the wait.
const ENTITY_LOCK_RETRY_MIN_MS = 25
const ENTITY_LOCK_RETRY_MAX_MS = 500
// How long one writer attempt queues for the gate, and pauses after failing, so uploads get turns.
const WRITER_LOCK_TIMEOUT_MS = 10_000
const WRITER_MAX_WAIT_MS = 60_000
const LOCK_NOT_AVAILABLE = '55P03'

// node-postgres reports a pool-connect timeout with one of two messages, depending on whether it was
// waiting for a free connection or still opening a new one.
const POOL_TIMEOUT_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout'
]

function isPoolTimeout(error: unknown): boolean {
  return error instanceof Error && POOL_TIMEOUT_MESSAGES.some((message) => error.message.includes(message))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Creates a distributed storage/GC gate on a separate WKC connection pool. Uploads share the gate;
 * deletion takes it exclusively, one writer per process at a time. Never release a held lock until its
 * storage operations settle.
 * @param components Configuration, logging and metrics for the dedicated lock pool.
 * @param options Writer lock bounds and pool connection timeout.
 * @returns Lifecycle-managed content locks shared by all instances using this database.
 */
export async function createContentLocks(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>,
  options: ContentLocksOptions = {}
): Promise<IContentLocks> {
  const writerLockTimeoutMs = options.writerLockTimeoutMs ?? WRITER_LOCK_TIMEOUT_MS
  const writerMaxWaitMs = options.writerMaxWaitMs ?? WRITER_MAX_WAIT_MS
  const max = await getPositiveInteger(components.config, 'CONTENT_LOCK_CONNECTIONS', 16)
  const pg = await createPgComponent(components, {
    pool: { max, connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000 }
  })

  // One attempt. Only GC queues on the exclusive gate, bounded by lock_timeout; uploads report a GC batch
  // or a busy entity back instead of waiting, so they never hold a pool connection while waiting.
  async function attempt<T>(
    exclusive: boolean,
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    entityId?: string
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    signal?.throwIfAborted()
    const acquisition: Promise<UploadClient> = pg.getPool().connect()
    let client: UploadClient
    try {
      client = await raceWithSignal(acquisition, signal)
    } catch (error) {
      void acquisition.then(
        (lateClient) => lateClient.release(),
        () => undefined
      )
      // A saturated pool is busy like a held lock: retried until the request's own deadline.
      if (isPoolTimeout(error)) {
        return { acquired: false }
      }
      throw error
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    // Reuse the connection unless its transport broke or a lock statement may still be running on it.
    let reusable = true
    let lockTimeoutSet = false
    const connectionError = (error: Error): void => {
      reusable = false
      controller.abort(error)
    }
    signal?.addEventListener('abort', abort, { once: true })
    client.on('error', connectionError)
    // Only a lock statement that fails or is abandoned on abort leaves the session in an unknown state.
    async function lockQuery<R extends Record<string, unknown>>(sql: string | SQLStatement): Promise<R[]> {
      try {
        return (await raceWithSignal(client.query<R>(sql), controller.signal)).rows
      } catch (error) {
        if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE) reusable = false
        throw error
      }
    }
    try {
      if (signal?.aborted) abort()
      if (exclusive) {
        await lockQuery(`SET lock_timeout = ${Math.ceil(writerLockTimeoutMs)}`)
        lockTimeoutSet = true
        try {
          await lockQuery(SQL`SELECT pg_advisory_lock(hashtextextended('worlds-content-gc', 0))`)
        } catch (error) {
          if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
            return { acquired: false }
          }
          throw error
        }
      } else {
        const gate = await lockQuery<{ acquired: boolean }>(
          SQL`SELECT pg_try_advisory_lock_shared(hashtextextended('worlds-content-gc', 0)) AS acquired`
        )
        if (!gate[0]?.acquired) {
          return { acquired: false }
        }
      }
      if (entityId) {
        const entityLock = await lockQuery<{ acquired: boolean }>(
          SQL`SELECT pg_try_advisory_lock(hashtextextended(${'partial-entity:' + entityId}, 0)) AS acquired`
        )
        if (!entityLock[0]?.acquired) {
          return { acquired: false }
        }
      }
      controller.signal.throwIfAborted()
      return { acquired: true, value: await operation(controller.signal) }
    } finally {
      signal?.removeEventListener('abort', abort)
      // A failed operation leaves a healthy connection: unlock and reuse it; destroy it only when
      // unlocking is impossible, since the session would otherwise keep its locks in the pool.
      if (reusable) {
        try {
          await client.query('SELECT pg_advisory_unlock_all()')
          if (lockTimeoutSet) await client.query('RESET lock_timeout')
        } catch {
          reusable = false
        }
      }
      client.removeListener('error', connectionError)
      client.release(!reusable)
    }
  }

  async function run<T>(
    exclusive: boolean,
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    entityId?: string
  ): Promise<T> {
    const writerDeadline = Date.now() + writerMaxWaitMs
    for (let delayMs = ENTITY_LOCK_RETRY_MIN_MS; ; delayMs = Math.min(delayMs * 2, ENTITY_LOCK_RETRY_MAX_MS)) {
      const result = await attempt(exclusive, operation, signal, entityId)
      if (result.acquired) {
        return result.value
      }
      if (exclusive && Date.now() + writerLockTimeoutMs > writerDeadline) {
        throw new ContentLockTimeoutError()
      }
      await sleep(exclusive ? writerLockTimeoutMs : delayMs, signal)
    }
  }

  // Writers are rare (GC and expired-upload cleanup). Queuing them in-process keeps a waiting writer from
  // holding more than one connection while it waits behind in-flight uploads.
  let writers: Promise<unknown> = Promise.resolve()
  function withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const turn = writers.then(() => run(true, operation))
    writers = turn.catch(() => undefined)
    return turn
  }

  return {
    [START_COMPONENT]: () => pg.start(),
    [STOP_COMPONENT]: () => pg.stop(),
    withRead: (operation, signal, entityId) => run(false, operation, signal, entityId),
    withWrite
  }
}
