import type { IPublisherComponent } from '@dcl/sns-component'
import type { WorldScenesUndeploymentEvent, WorldUndeploymentEvent } from '@dcl/schemas'
import type { ILoggerComponent } from '@well-known-components/interfaces'

const MAX_PUBLISH_ATTEMPTS = 3
const BASE_RETRY_DELAY_MS = 100
const RETRY_JITTER_RATIO = 0.1

type WorldEvent = WorldUndeploymentEvent | WorldScenesUndeploymentEvent

export class WorldEventPublicationError extends Error {
  readonly cause: unknown

  constructor(event: WorldEvent, attempts: number, cause?: unknown) {
    super(`Failed to publish ${event.subType} for world "${event.metadata.worldName}" after ${attempts} attempts`)
    this.name = 'WorldEventPublicationError'
    this.cause = cause
  }
}

function retryDelay(attempt: number): number {
  const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)
  return backoff + Math.floor(Math.random() * backoff * RETRY_JITTER_RATIO)
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Publishes a single world event and retries transient exceptions or failures reported by SNS.
 *
 * @param snsClient - SNS publisher component
 * @param logger - Structured logger used for retry diagnostics
 * @param event - World event to publish
 * @returns A promise that resolves after SNS confirms publication
 * @throws {WorldEventPublicationError} After all publication attempts fail
 */
export async function publishWorldEventWithRetry(
  snsClient: IPublisherComponent,
  logger: ILoggerComponent.ILogger,
  event: WorldEvent
): Promise<void> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    let failed = false
    try {
      const result = await snsClient.publishMessages([event])
      failed = result.failedEvents.length > 0 || result.successfulMessageIds.length !== 1
      lastError = undefined
    } catch (error: unknown) {
      failed = true
      lastError = error
    }

    if (!failed) {
      return
    }

    if (attempt < MAX_PUBLISH_ATTEMPTS) {
      const delayMs = retryDelay(attempt)
      logger.warn('World event publication failed, retrying', {
        worldName: event.metadata.worldName,
        eventSubType: event.subType,
        attempt,
        maxAttempts: MAX_PUBLISH_ATTEMPTS,
        delayMs
      })
      await wait(delayMs)
    }
  }

  throw new WorldEventPublicationError(event, MAX_PUBLISH_ATTEMPTS, lastError)
}
