import { AppComponents, IPartialDeploymentSweeper } from '../types'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export type SweeperOptions = {
  intervalMs?: number
  onCleanupExpiredEntity: (entityId: string) => Promise<void>
}

export function createPartialDeploymentSweeper(
  components: Pick<AppComponents, 'partialDeploymentStore' | 'logs'>,
  options: SweeperOptions
): IPartialDeploymentSweeper & { runOnce(): Promise<void> } {
  const { partialDeploymentStore: store, logs } = components
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const logger = logs.getLogger('partial-deployment-sweeper')

  let timer: NodeJS.Timeout | undefined

  async function runOnce(): Promise<void> {
    const expired = await store.listExpiredBefore(Date.now())
    for (const entityId of expired) {
      try {
        await options.onCleanupExpiredEntity(entityId)
      } catch (err: any) {
        logger.warn(`Cleanup of ${entityId} failed`, { err: String(err) })
      } finally {
        await store.delete(entityId)
      }
    }
    if (expired.length > 0) {
      logger.info(`Swept ${expired.length} expired partial deployments`)
    }
  }

  return {
    async start(): Promise<void> {
      if (timer) return
      timer = setInterval(() => {
        runOnce().catch((err) => logger.error(`sweep tick failed`, { err: String(err) }))
      }, intervalMs)
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    runOnce
  }
}
