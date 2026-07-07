import { createJobComponent, IJobComponent } from '@dcl/job-component'
import { AppComponents } from '../types'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_PENDING_DEPLOYMENT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function createEvictionJob(
  components: Pick<AppComponents, 'config' | 'logs' | 'worlds' | 'pendingScenesManager'>
): Promise<IJobComponent> {
  const { config, logs, worlds, pendingScenesManager } = components
  const logger = logs.getLogger('eviction-job')
  const evictionTtlMs = (await config.getNumber('SCENE_EVICTION_TTL_MS')) ?? DEFAULT_TTL_MS
  const pendingTtlMs = (await config.getNumber('PENDING_DEPLOYMENT_TTL')) ?? DEFAULT_PENDING_DEPLOYMENT_TTL_MS

  return createJobComponent(
    { logs },
    async () => {
      logger.info('Running eviction job...')
      const evicted = await worlds.evictUndeployedWorlds(evictionTtlMs)
      const expiredPending = await pendingScenesManager.deleteExpired(pendingTtlMs)
      logger.info(`Eviction completed. Deleted ${evicted} scene(s) and ${expiredPending} expired pending upload(s).`)
    },
    ONE_DAY_MS,
    { repeat: true, onError: (err) => logger.error(`Eviction job failed: ${err}`) }
  )
}
