import { BaseComponents } from '../../types'
import { MultipartBodyReceivedEvent, MultipartCleanupErrorEvent, MultipartTelemetryEvent } from './types'

export type MultipartUploadTelemetry = {
  onTelemetry: (event: MultipartTelemetryEvent) => void
  onBodyReceived: (event: MultipartBodyReceivedEvent) => void
  onCleanupError: (event: MultipartCleanupErrorEvent) => void
}

/**
 * Connects multipart upload outcomes and cleanup failures to application metrics and logs.
 *
 * @param components Logging and metrics dependencies.
 * @returns The telemetry, body-received and cleanup-error callbacks to pass to every multipart route.
 */
export function createMultipartUploadTelemetry(
  components: Pick<BaseComponents, 'logs' | 'metrics'>
): MultipartUploadTelemetry {
  const { logs, metrics } = components
  const logger = logs.getLogger('multipart-uploads')
  const onTelemetry = (event: MultipartTelemetryEvent): void => {
    metrics.observe(
      'multipart_upload_size_bytes',
      {
        route: event.route,
        content_length: event.contentLengthPresent ? 'present' : 'absent',
        outcome: event.kind
      },
      event.actualBytes
    )
    if (event.kind === 'rejected') {
      metrics.increment('multipart_upload_rejections', { route: event.route, reason: event.reason })
      logger.warn('Multipart upload rejected', {
        route: event.route,
        reason: event.reason,
        actualBytes: event.actualBytes,
        reservedBytes: event.snapshot.reservedBytes,
        orphanedBytes: event.snapshot.orphanedBytes,
        reservedFiles: event.snapshot.reservedFiles,
        orphanedFiles: event.snapshot.orphanedFiles,
        orphanedDirectories: event.snapshot.orphanedDirectories,
        capacity: event.snapshot.capacity,
        minUploadReservationBytes: event.snapshot.minUploadReservationBytes,
        uploadFileOverheadBytes: event.snapshot.uploadFileOverheadBytes,
        maxOrphanedUploadDirectories: event.snapshot.maxOrphanedUploadDirectories,
        activeUploads: event.snapshot.activeUploads,
        maxConcurrentUploads: event.snapshot.maxConcurrentUploads,
        contentLengthPresent: String(event.contentLengthPresent)
      })
    }
  }
  const onBodyReceived = ({ route, outcome, durationSeconds }: MultipartBodyReceivedEvent): void => {
    metrics.observe('multipart_upload_receive_duration_seconds', { route, outcome }, durationSeconds)
  }
  const onCleanupError = ({ route, error, attempt, willRetry }: MultipartCleanupErrorEvent): void => {
    if (attempt === 0) {
      metrics.increment('multipart_upload_cleanup_failures', { route })
    } else {
      metrics.increment('multipart_upload_cleanup_retry_failures', { route })
    }
    logger.warn('Failed to clean up multipart upload directory', {
      route,
      error: error.message,
      attempt,
      willRetry: String(willRetry)
    })
  }

  return { onTelemetry, onBodyReceived, onCleanupError }
}
