import { IConfigComponent } from '@well-known-components/interfaces'

/**
 * Reads and validates a positive integer concurrency setting.
 *
 * @param config Configuration provider.
 * @param key Environment variable name.
 * @param fallback Value used when the setting is absent.
 * @returns Configured concurrency.
 * @throws When the configured or fallback value is not a positive safe integer.
 */
export async function getConcurrency(
  config: Pick<IConfigComponent, 'getNumber'>,
  key: string,
  fallback: number
): Promise<number> {
  const value = (await config.getNumber(key)) ?? fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive safe integer, got ${value}`)
  }
  return value
}

/**
 * Rejects when a signal aborts without waiting for an operation that cannot consume that signal.
 * The operation remains observed until it settles, preventing a late rejection from becoming unhandled.
 * Use only when returning early cannot release resources still owned by the operation.
 *
 * @param operation Operation to observe.
 * @param signal Optional cancellation signal.
 * @returns The operation result when it settles before cancellation.
 * @throws The signal's abort reason when cancellation wins the race.
 */
export async function raceWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation
  }
  signal.throwIfAborted()

  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('Operation was aborted.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (result) => {
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

/**
 * Maps work through a continuous, bounded worker pool.
 *
 * Workers stop taking new items after the first failure, but every already-started task is allowed
 * to settle before the error is rethrown. This is important when tasks consume request-scoped files.
 *
 * @param items Items to process.
 * @param concurrency Maximum simultaneously running tasks.
 * @param mapper Asynchronous operation applied to each item.
 * @param options Cancellation signal and whether already-started work must settle before returning.
 * @returns Results in input order.
 * @throws The first mapper error, cancellation reason, or invalid-concurrency error.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options?: { signal?: AbortSignal; waitForActiveOnAbort?: boolean }
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Concurrency must be a positive safe integer, got ${concurrency}`)
  }

  const results = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  let firstError: unknown
  const signal = options?.signal
  const waitForActiveOnAbort = options?.waitForActiveOnAbort ?? true
  let rejectOnAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject
  })

  const abort = (): void => {
    if (!failed) {
      failed = true
      firstError = signal?.reason ?? new Error('Concurrent work was aborted.')
    }
    if (!waitForActiveOnAbort) {
      rejectOnAbort?.(signal?.reason ?? firstError)
    }
  }
  if (signal?.aborted) {
    abort()
  } else {
    signal?.addEventListener('abort', abort, { once: true })
  }

  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex++
      if (index >= items.length) {
        return
      }

      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  const workers = Promise.all(Array.from({ length: workerCount }, () => worker()))
  try {
    await (waitForActiveOnAbort ? workers : Promise.race([workers, aborted]))
  } finally {
    signal?.removeEventListener('abort', abort)
  }
  if (failed) {
    throw firstError
  }
  return results
}
