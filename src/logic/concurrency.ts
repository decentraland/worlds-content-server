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
 * Maps work through a continuous, bounded worker pool.
 *
 * Workers stop taking new items after the first failure, but every already-started task is allowed
 * to settle before the error is rethrown. This is important when tasks consume request-scoped files.
 *
 * @param items Items to process.
 * @param concurrency Maximum simultaneously running tasks.
 * @param mapper Asynchronous operation applied to each item.
 * @returns Results in input order.
 * @throws The first mapper error after all started tasks settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options?: { signal?: AbortSignal }
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Concurrency must be a positive safe integer, got ${concurrency}`)
  }

  const results = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  let firstError: unknown
  const signal = options?.signal

  const abort = (): void => {
    if (!failed) {
      failed = true
      firstError = signal?.reason ?? new Error('Concurrent work was aborted.')
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
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    signal?.removeEventListener('abort', abort)
  }
  if (failed) {
    throw firstError
  }
  return results
}
