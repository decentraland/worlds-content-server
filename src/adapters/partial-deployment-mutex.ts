export type Mutex = {
  run<T>(key: string, op: () => Promise<T>): Promise<T>
}

export function createMutex(): Mutex {
  const chains = new Map<string, Promise<unknown>>()

  return {
    async run<T>(key: string, op: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(op)
      chains.set(key, next)
      try {
        return await next
      } finally {
        // Best-effort cleanup: only remove if still pointing at this run's promise.
        if (chains.get(key) === next) {
          chains.delete(key)
        }
      }
    }
  }
}
