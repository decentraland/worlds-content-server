import type {
  AppComponents,
  DeploymentAbortContext,
  DeploymentProcessingStage,
  IDeploymentProcessingComponent
} from '../types'
import { getConcurrency } from './concurrency'

export const DEFAULT_STORAGE_UPLOAD_CONCURRENCY = 10
export const DEFAULT_FILE_HASH_CONCURRENCY = 4
export const DEFAULT_CONTENT_FILE_INFO_CONCURRENCY = 64
export const DEFAULT_DEPLOYMENT_PROCESSING_TIMEOUT_MS = 300_000

export class DeploymentProcessingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Deployment processing exceeded the ${timeoutMs}ms deadline.`)
    this.name = 'DeploymentProcessingTimeoutError'
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Deployment processing was aborted.')
}

function outcomeFor(error: unknown): 'timeout' | 'aborted' | 'error' {
  if (error instanceof DeploymentProcessingTimeoutError) {
    return 'timeout'
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'aborted'
  }
  return 'error'
}

/**
 * Creates the request-scoped deployment processing coordinator.
 *
 * Configuration is loaded and validated during component initialization. The component combines
 * request cancellation with a processing deadline and records bounded-stage activity without
 * changing the intentionally per-request concurrency model.
 *
 * @param components Configuration, logging, and metrics dependencies.
 * @returns Deployment processing coordinator with validated immutable settings.
 */
export async function createDeploymentProcessingComponent(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics'>
): Promise<IDeploymentProcessingComponent> {
  const { config, logs, metrics } = components
  const [storageConcurrency, hashConcurrency, fileInfoConcurrency, timeoutMs] = await Promise.all([
    getConcurrency(config, 'DEPLOYMENT_STORAGE_CONCURRENCY', DEFAULT_STORAGE_UPLOAD_CONCURRENCY),
    getConcurrency(config, 'DEPLOYMENT_HASH_CONCURRENCY', DEFAULT_FILE_HASH_CONCURRENCY),
    getConcurrency(config, 'DEPLOYMENT_FILE_INFO_CONCURRENCY', DEFAULT_CONTENT_FILE_INFO_CONCURRENCY),
    getConcurrency(config, 'DEPLOYMENT_PROCESSING_TIMEOUT_MS', DEFAULT_DEPLOYMENT_PROCESSING_TIMEOUT_MS)
  ])
  const logger = logs.getLogger('deployment-processing')
  const activeStages = new Map<DeploymentProcessingStage, number>()
  const activeWorkers = new Map<DeploymentProcessingStage, number>()

  logger.info('Deployment processing configured', {
    fileInfoConcurrency,
    hashConcurrency,
    storageConcurrency,
    timeoutMs
  })

  function updateActive(
    counts: Map<DeploymentProcessingStage, number>,
    metric: 'deployment_processing_stage_active' | 'deployment_processing_worker_active',
    stage: DeploymentProcessingStage,
    delta: number
  ): void {
    const active = Math.max(0, (counts.get(stage) ?? 0) + delta)
    counts.set(stage, active)
    metrics.observe(metric, { stage }, active)
  }

  function createAbortContext(parentSignal?: AbortSignal): DeploymentAbortContext {
    const controller = new AbortController()
    const abortFromParent = (): void => controller.abort(parentSignal ? abortReason(parentSignal) : undefined)
    if (parentSignal?.aborted) {
      abortFromParent()
    } else {
      parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    }
    const timeout = setTimeout(() => controller.abort(new DeploymentProcessingTimeoutError(timeoutMs)), timeoutMs)
    timeout.unref()

    return {
      signal: controller.signal,
      dispose(): void {
        clearTimeout(timeout)
        parentSignal?.removeEventListener('abort', abortFromParent)
      }
    }
  }

  async function trackStage<T>(
    stage: DeploymentProcessingStage,
    items: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const startedAt = performance.now()
    updateActive(activeStages, 'deployment_processing_stage_active', stage, 1)
    metrics.observe('deployment_processing_stage_items', { stage }, items)
    let outcome: 'success' | 'timeout' | 'aborted' | 'error' = 'success'
    try {
      return await operation()
    } catch (error) {
      outcome = outcomeFor(error)
      metrics.increment('deployment_processing_failures', { stage, outcome })
      throw error
    } finally {
      metrics.observe(
        'deployment_processing_stage_duration_seconds',
        { stage, outcome },
        (performance.now() - startedAt) / 1000
      )
      updateActive(activeStages, 'deployment_processing_stage_active', stage, -1)
    }
  }

  async function trackWorker<T>(stage: DeploymentProcessingStage, operation: () => Promise<T>): Promise<T> {
    updateActive(activeWorkers, 'deployment_processing_worker_active', stage, 1)
    try {
      return await operation()
    } finally {
      updateActive(activeWorkers, 'deployment_processing_worker_active', stage, -1)
    }
  }

  return {
    fileInfoConcurrency,
    hashConcurrency,
    storageConcurrency,
    timeoutMs,
    createAbortContext,
    trackStage,
    trackWorker
  }
}
