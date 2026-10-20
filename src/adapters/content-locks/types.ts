import { IBaseComponent } from '@well-known-components/interfaces'

export interface IContentLocks extends IBaseComponent {
  /** Protects storage reads/writes through publication. Optional entity key serializes its batches. */
  withRead<T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, entityId?: string): Promise<T>
  /**
   * Excludes uploads while references are checked and a GC batch is physically deleted. The writer
   * only tries the lock between backoffs, so new uploads are never held behind it.
   * @throws ContentLockTimeoutError when in-flight uploads keep the gate past the bounded wait.
   */
  withWrite<T>(operation: () => Promise<T>): Promise<T>
}

export type ContentLocksOptions = {
  /** How long one attempt waits for a pool connection, in milliseconds. */
  connectionTimeoutMs?: number
  /** Longest pause between a writer's attempts to take the exclusive lock, in milliseconds. */
  writerRetryMaxMs?: number
  /** Longest a writer retries before failing, in milliseconds. */
  writerMaxWaitMs?: number
}
