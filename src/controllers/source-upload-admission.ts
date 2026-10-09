import { IHttpServerComponent } from '@dcl/core-commons'
import { SourceUploadLease, SourceUploadLimitExceededError } from '../adapters/source-upload-limits'
import { AppComponents } from '../types'

// A slot frees when one of the source's uploads ends, which the source itself controls.
const SOURCE_UPLOAD_RETRY_AFTER_SECONDS = 5

/**
 * Admits a multipart body, before it is read, only while its source has fewer uploads and bytes in
 * flight than its share, and holds that share until the request ends. Applies to every request on the
 * route, since a body that never completes is never authenticated. A request with no client source
 * is not limited per source.
 * @param components Client-source resolver, per-source limits and metrics.
 * @param options Route label and the route's largest accepted payload.
 * @returns Middleware to place before the multipart parser.
 */
export function createSourceUploadAdmission(
  components: Pick<AppComponents, 'clientSource' | 'metrics' | 'sourceUploadLimits'>,
  options: { route: string; maxRequestBytes: number }
): (
  context: IHttpServerComponent.DefaultContext,
  next: () => Promise<IHttpServerComponent.IResponse>
) => Promise<IHttpServerComponent.IResponse> {
  const { clientSource, metrics, sourceUploadLimits } = components
  const maxRequestBytes = Math.min(options.maxRequestBytes, sourceUploadLimits.maxRequestBytes)
  return async (context, next) => {
    // Node rejects a body past its declared length; one without a declaration may grow to the cap.
    const header = context.request.headers.get('content-length')
    const declared = header !== null && /^\d+$/.test(header) ? Number(header) : NaN
    const bytes = Number.isSafeInteger(declared) ? Math.min(declared, maxRequestBytes) : maxRequestBytes
    const source = clientSource.getClientSource(context.request)
    // Unattributed callers (internal services, direct routes) would otherwise lock each other out in
    // one shared share; only the process-wide budget bounds them, and they are counted.
    if (source === undefined) {
      metrics.increment('multipart_upload_unattributed', { route: options.route })
      return next()
    }
    let lease: SourceUploadLease
    try {
      lease = sourceUploadLimits.acquire(source, bytes)
    } catch (error) {
      if (!(error instanceof SourceUploadLimitExceededError)) throw error
      metrics.increment('multipart_upload_rejections', { route: options.route, reason: error.reason })
      return {
        status: 429,
        headers: { 'Retry-After': String(SOURCE_UPLOAD_RETRY_AFTER_SECONDS) },
        body: { error: 'Too Many Requests', message: error.message }
      }
    }
    try {
      return await next()
    } finally {
      lease.release()
    }
  }
}
