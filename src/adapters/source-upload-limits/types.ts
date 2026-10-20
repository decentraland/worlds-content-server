/** One admitted upload's share of its source's in-flight allowance. */
export type SourceUploadLease = {
  /** Returns the share to the source. Idempotent. */
  release(): void
}

/**
 * Per-client-source bound on multipart bodies in flight in this process, so one source can hold only a
 * small share of the process-wide upload budget however many requests it opens. Applied before the body
 * is read, to every request, since a body that never completes is never authenticated.
 */
export type ISourceUploadLimits = {
  /** Largest request the per-source byte share is sized for; undeclared bodies are charged this much. */
  maxRequestBytes: number
  /**
   * Admits an upload of up to `bytes` from `source`.
   * @throws SourceUploadLimitExceededError when the source already has its share in flight.
   */
  acquire(source: string, bytes: number): SourceUploadLease
}
