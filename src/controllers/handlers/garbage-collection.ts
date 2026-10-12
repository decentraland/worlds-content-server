import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { ContentLockTimeoutError } from '../../adapters/content-locks/errors'

/** Retry hint when uploads keep the content lock busy. */
export const GC_DEFERRED_RETRY_AFTER_SECONDS = 60

type GarbageCollectionContext = HandlerContextWithPath<'contentGc' | 'metrics', '/gc'>

/**
 * Runs garbage collection, recording its outcome, duration and last success. Answers 503 with
 * Retry-After when uploads keep the content lock busy.
 */
export async function garbageCollectionHandler(
  context: GarbageCollectionContext
): Promise<IHttpServerComponent.IResponse> {
  const { contentGc, metrics } = context.components
  const { end } = metrics.startTimer('garbage_collection_duration_seconds')
  let outcome: 'success' | 'deferred' | 'error' = 'error'
  try {
    const { removed, expiredUploads } = await contentGc.collectGarbage()
    outcome = 'success'
    metrics.observe('garbage_collection_last_success_timestamp_seconds', {}, Date.now() / 1000)
    return {
      status: 200,
      body: { message: `Garbage collection removed ${removed} unused keys.`, expiredUploads }
    }
  } catch (error) {
    if (error instanceof ContentLockTimeoutError) {
      outcome = 'deferred'
      return {
        status: 503,
        headers: { 'Retry-After': String(GC_DEFERRED_RETRY_AFTER_SECONDS) },
        body: { error: 'Service Unavailable', message: error.message }
      }
    }
    throw error
  } finally {
    end()
    metrics.increment('garbage_collection_runs', { outcome })
  }
}
