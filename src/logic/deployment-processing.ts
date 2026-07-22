import type {
  AppComponents,
  DeploymentAbortContext,
  DeploymentProcessingStage,
  IDeploymentProcessingComponent
} from '../types'
import { InvalidRequestError } from '@dcl/http-commons'
import { getPositiveInteger } from './concurrency'

export const DEFAULT_STORAGE_UPLOAD_CONCURRENCY = 10
export const DEFAULT_FILE_HASH_CONCURRENCY = 4
export const DEFAULT_CONTENT_FILE_INFO_CONCURRENCY = 64
export const DEFAULT_DEPLOYMENT_PROCESSING_TIMEOUT_MS = 300_000
/** Largest delay supported without overflow by Node timers and PostgreSQL statement_timeout. */
export const MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS = 2_147_483_647

export class DeploymentProcessingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Deployment processing exceeded the ${timeoutMs}ms deadline.`)
    this.name = 'DeploymentProcessingTimeoutError'
  }
}

/** Typed wrapper used to distinguish request disconnects from operational failures in telemetry. */
export class DeploymentProcessingAbortedError extends Error {
  readonly reason: unknown

  constructor(reason?: unknown) {
    super(
      typeof reason === 'object' && reason !== null && 'message' in reason && typeof reason.message === 'string'
        ? reason.message
        : 'Deployment processing was aborted.'
    )
    this.name = 'DeploymentProcessingAbortedError'
    this.reason = reason
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof DeploymentProcessingTimeoutError
    ? signal.reason
    : new DeploymentProcessingAbortedError(signal.reason)
}

/**
 * Matches both DOMException-based abort errors and Node's internal AbortError (fs, streams),
 * which is a plain Error subclass carrying the signal reason in `cause` rather than being it.
 */
function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
}

/**
 * Whether an error represents expected request cancellation (client disconnect or the processing
 * deadline) rather than an operational failure. Cancellation surfaces either as the typed errors
 * installed on the abort signal or as an AbortError when a Node API consumes the signal directly.
 *
 * @param error Error to classify.
 * @returns True when the error is a cancellation, false for genuine failures.
 */
export function isProcessingCancellationError(error: unknown): boolean {
  return (
    error instanceof DeploymentProcessingTimeoutError ||
    error instanceof DeploymentProcessingAbortedError ||
    isAbortError(error)
  )
}

function outcomeFor(error: unknown): 'timeout' | 'aborted' | 'client-error' | 'error' {
  if (
    error instanceof DeploymentProcessingTimeoutError ||
    (isAbortError(error) && (error as Error & { cause?: unknown }).cause instanceof DeploymentProcessingTimeoutError)
  ) {
    return 'timeout'
  }
  if (error instanceof DeploymentProcessingAbortedError || isAbortError(error)) {
    return 'aborted'
  }
  // Client mistakes (invalid entities, failed validations) are kept out of the operational-failure
  // outcome so dashboards and alerts on `outcome="error"` only reflect server-side problems.
  if (error instanceof InvalidRequestError) {
    return 'client-error'
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
    getPositiveInteger(config, 'DEPLOYMENT_STORAGE_CONCURRENCY', DEFAULT_STORAGE_UPLOAD_CONCURRENCY),
    getPositiveInteger(config, 'DEPLOYMENT_HASH_CONCURRENCY', DEFAULT_FILE_HASH_CONCURRENCY),
    getPositiveInteger(config, 'DEPLOYMENT_FILE_INFO_CONCURRENCY', DEFAULT_CONTENT_FILE_INFO_CONCURRENCY),
    getPositiveInteger(config, 'DEPLOYMENT_PROCESSING_TIMEOUT_MS', DEFAULT_DEPLOYMENT_PROCESSING_TIMEOUT_MS)
  ])
  if (timeoutMs > MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS) {
    throw new Error(
      `DEPLOYMENT_PROCESSING_TIMEOUT_MS must be at most ${MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS}, got ${timeoutMs}`
    )
  }
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
    const deadlineAt = Date.now() + timeoutMs
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
      deadlineAt,
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
    let outcome: 'success' | 'timeout' | 'aborted' | 'client-error' | 'error' = 'success'
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
