import { createJobComponent, IJobComponent } from '@dcl/job-component'
import { AppComponents } from '../types'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function createEvictionJob(
  components: Pick<AppComponents, 'config' | 'logs' | 'worlds'>
): Promise<IJobComponent> {
  const { config, logs, worlds } = components
  const logger = logs.getLogger('eviction-job')
  const evictionTtlMs = (await config.getNumber('SCENE_EVICTION_TTL_MS')) ?? DEFAULT_TTL_MS

  return createJobComponent(
    { logs },
    async () => {
      logger.info('Running eviction job...')
      const evicted = await worlds.evictUndeployedWorlds(evictionTtlMs)
      logger.info(`Eviction completed. Deleted ${evicted} scene(s).`)
    },
    ONE_DAY_MS,
    { repeat: true, onError: (err) => logger.error(`Eviction job failed: ${err}`) }
  )
}
