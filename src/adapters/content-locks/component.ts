import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { createPgComponent } from '@dcl/pg-component'
import SQL from 'sql-template-strings'
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
    const connectionError = (error: Error): void => controller.abort(error)
    signal?.addEventListener('abort', abort, { once: true })
    client.on('error', connectionError)
    let failed = false
    try {
      if (signal?.aborted) abort()
      if (exclusive) {
        await client.query(`SET lock_timeout = ${Math.ceil(writerLockTimeoutMs)}`)
        try {
          await raceWithSignal(
            client.query(SQL`SELECT pg_advisory_lock(hashtextextended('worlds-content-gc', 0))`),
            controller.signal
          )
        } catch (error) {
          if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
            return { acquired: false }
          }
          throw error
        }
      } else {
        const gate = await raceWithSignal(
          client.query<{ acquired: boolean }>(
            SQL`SELECT pg_try_advisory_lock_shared(hashtextextended('worlds-content-gc', 0)) AS acquired`
          ),
          controller.signal
        )
        if (!gate.rows[0]?.acquired) {
          return { acquired: false }
        }
      }
      if (entityId) {
        const entityLock = await raceWithSignal(
          client.query<{ acquired: boolean }>(
            SQL`SELECT pg_try_advisory_lock(hashtextextended(${'partial-entity:' + entityId}, 0)) AS acquired`
          ),
          controller.signal
        )
        if (!entityLock.rows[0]?.acquired) {
          return { acquired: false }
        }
      }
      controller.signal.throwIfAborted()
      return { acquired: true, value: await operation(controller.signal) }
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
          if (exclusive) await client.query('RESET lock_timeout')
        } catch {
          failed = true
        }
      }
      client.removeListener('error', connectionError)
      client.release(failed)
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
