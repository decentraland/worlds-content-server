import { createJobComponent, IJobComponent } from '@dcl/job-component'
import { AppComponents } from '../../types'

/**
 * Creates the scheduled sweep of expired partial uploads. It runs at start and then every
 * `uploadLimits.partialUploadCleanupIntervalMs` after the previous run finishes, so expired uploads stop
 * holding quota and storage soon after their lifetime ends. Stops with the component lifecycle.
 * @param components Logging, the content GC that runs the cleanup and the validated upload limits.
 * @returns A job component that runs until the application stops.
 */
export async function createPartialUploadCleanupJob(
  components: Pick<AppComponents, 'logs' | 'contentGc' | 'uploadLimits'>
): Promise<IJobComponent> {
  const { logs, contentGc, uploadLimits } = components
  const logger = logs.getLogger('partial-upload-cleanup-job')

  return createJobComponent(
    { logs },
    async () => {
      await contentGc.deleteExpiredUploads()
    },
    uploadLimits.partialUploadCleanupIntervalMs,
    { repeat: true, onError: (error) => logger.error(`Failed to delete expired partial uploads: ${error}`) }
  )
}
