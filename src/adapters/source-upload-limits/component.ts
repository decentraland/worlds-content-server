import { AppComponents } from '../../types'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES } from '../../logic/upload-limits'
import { SourceUploadLimitExceededError } from './errors'
import { ISourceUploadLimits, SourceUploadLease } from './types'

/**
 * Creates the per-source in-flight upload limits of this process. They bound this process's upload
 * budget, so they are process-local by design.
 * @param components The validated upload limits.
 * @returns The per-source upload limits.
 */
export async function createSourceUploadLimits(
  components: Pick<AppComponents, 'uploadLimits'>
): Promise<ISourceUploadLimits> {
  const { uploadLimits } = components
  const maxRequestBytes = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
  const maxUploads = uploadLimits.maxConcurrentUploadsPerSource
  const maxBytes = uploadLimits.maxInFlightUploadBytesPerSource

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
