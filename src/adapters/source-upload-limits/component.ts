import { AppComponents } from '../../types'
import { getPositiveInteger } from '../../logic/concurrency'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES } from '../../logic/multipart'
import { SourceUploadLimitExceededError } from './errors'
import { ISourceUploadLimits, SourceUploadLease } from './types'

export const DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SOURCE = 4

/**
 * Creates the per-source in-flight upload limits of this process. They bound this process's upload
 * budget, so they are process-local by design.
 * @param components Configuration.
 * @returns The per-source upload limits.
 * @throws Error when the per-source byte share cannot fit one maximum-size request.
 */
export async function createSourceUploadLimits(
  components: Pick<AppComponents, 'config'>
): Promise<ISourceUploadLimits> {
  const { config } = components
  const maxRequestBytes = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  const maxUploads = await getPositiveInteger(
    config,
    'MAX_CONCURRENT_UPLOADS_PER_SOURCE',
    DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SOURCE
  )
  const maxBytes = await getPositiveInteger(config, 'MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE', maxRequestBytes)
  if (maxBytes < maxRequestBytes) {
    throw new Error(
      `MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE (${maxBytes}) must fit one maximum-size upload (${maxRequestBytes} bytes).`
    )
  }

  // Only sources with an upload in flight have an entry.
  const inFlight = new Map<string, { uploads: number; bytes: number }>()

  function acquire(source: string, bytes: number): SourceUploadLease {
    const current = inFlight.get(source) ?? { uploads: 0, bytes: 0 }
    if (current.uploads >= maxUploads) throw new SourceUploadLimitExceededError('source_concurrency')
    if (current.bytes + bytes > maxBytes) throw new SourceUploadLimitExceededError('source_bytes')
    current.uploads++
    current.bytes += bytes
    inFlight.set(source, current)

    let released = false
    return {
      release(): void {
        if (released) return
        released = true
        current.uploads--
        current.bytes -= bytes
        if (current.uploads === 0) inFlight.delete(source)
      }
    }
  }

  return { maxRequestBytes, acquire }
}
