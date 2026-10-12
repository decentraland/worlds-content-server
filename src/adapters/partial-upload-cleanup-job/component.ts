import { createJobComponent, IJobComponent } from '@dcl/job-component'
import { AppComponents } from '../../types'

/**
 * Creates the scheduled sweep of expired partial uploads. It runs at start and then every
 * `pendingScenesManager.cleanupIntervalMs` after the previous run finishes, so expired uploads stop
 * holding quota and storage soon after their lifetime ends. Stops with the component lifecycle.
 * @param components Logging and the pending-scenes manager that owns expiry and cleanup.
 * @returns A job component that runs until the application stops.
 */
export async function createPartialUploadCleanupJob(
  components: Pick<AppComponents, 'logs' | 'pendingScenesManager'>
): Promise<IJobComponent> {
  const { logs, pendingScenesManager } = components
  const logger = logs.getLogger('partial-upload-cleanup-job')

  return createJobComponent(
    { logs },
    async () => {
      await pendingScenesManager.deleteExpired()
    },
    pendingScenesManager.cleanupIntervalMs,
    { repeat: true, onError: (error) => logger.error(`Failed to delete expired partial uploads: ${error}`) }
  )
}
