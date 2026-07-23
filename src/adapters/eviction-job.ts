import { createJobComponent, IJobComponent } from '@dcl/job-component'
import { AppComponents } from '../types'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function createEvictionJob(
  components: Pick<AppComponents, 'config' | 'logs' | 'worlds' | 'pendingScenesManager'>
): Promise<IJobComponent> {
  const { config, logs, worlds, pendingScenesManager } = components
  const logger = logs.getLogger('eviction-job')
  const evictionTtlMs = (await config.getNumber('SCENE_EVICTION_TTL_MS')) ?? DEFAULT_TTL_MS

  return createJobComponent(
    { logs },
    async () => {
      logger.info('Running eviction job...')
      // The two clean-up steps are independent — isolate their failures so a broken scene eviction
      // doesn't also stall the purge of expired pending uploads (or vice versa) for a whole cycle.
      let evicted = 0
      try {
        evicted = await worlds.evictUndeployedWorlds(evictionTtlMs)
      } catch (error) {
        logger.error(`Failed to evict undeployed scenes: ${error}`)
      }
      // The pending-scenes manager owns the PENDING_DEPLOYMENT_TTL, so expiry uses its configured value.
      let expiredPending = 0
      try {
        expiredPending = await pendingScenesManager.deleteExpired()
      } catch (error) {
        logger.error(`Failed to delete expired pending uploads: ${error}`)
      }
      logger.info(`Eviction completed. Deleted ${evicted} scene(s) and ${expiredPending} expired pending upload(s).`)
    },
    ONE_DAY_MS,
    { repeat: true, onError: (err) => logger.error(`Eviction job failed: ${err}`) }
  )
}
