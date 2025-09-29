import {
  PublishBatchCommand,
  PublishBatchCommandOutput,
  PublishCommand,
  PublishCommandOutput,
  SNSClient as AwsSnsClient
} from '@aws-sdk/client-sns'
import { AppComponents, SnsClient } from '../types'
import {
  WorldsPermissionGrantedEvent,
  WorldsPermissionRevokedEvent,
  WorldsAccessRestrictedEvent,
  WorldsAccessRestoredEvent,
  WorldsMissingResourcesEvent
} from '@dcl/schemas'

export async function createSnsClient({
  awsConfig,
  config,
  logs
}: Pick<AppComponents, 'awsConfig' | 'config' | 'logs'>): Promise<SnsClient> {
  const sns = new AwsSnsClient(awsConfig)
  const logger = logs.getLogger('sns-client')
  const snsArn = await config.requireString('SNS_ARN')
  const maxRetries = (await config.getNumber('SNS_MAX_RETRIES')) || 3
  const retryDelay = (await config.getNumber('SNS_RETRY_DELAY_MS')) || 1000

  async function withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxAttempts: number = maxRetries
  ): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error as Error
        logger.warn(`${operationName} failed (attempt ${attempt}/${maxAttempts})`, { error: lastError.message })

        if (attempt < maxAttempts) {
          const delay = retryDelay * Math.pow(2, attempt - 1) // Exponential backoff
          logger.info(`Retrying ${operationName} in ${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    logger.error(`${operationName} failed after ${maxAttempts} attempts`, {
      error: lastError?.message || 'Unknown error'
    })
    throw lastError
  }

  function publish(
    payload:
      | PublishCommand
      | WorldsPermissionGrantedEvent
      | WorldsPermissionRevokedEvent
      | WorldsAccessRestrictedEvent
      | WorldsAccessRestoredEvent
      | WorldsMissingResourcesEvent
  ): Promise<PublishCommandOutput> {
    // If it's already a PublishCommand, send it directly
    if (payload instanceof PublishCommand) {
      return withRetry(() => sns.send(payload), 'SNS publish')
    }

    // Otherwise, treat it as a world content server event
    const event = payload as
      | WorldsPermissionGrantedEvent
      | WorldsPermissionRevokedEvent
      | WorldsAccessRestrictedEvent
      | WorldsAccessRestoredEvent
      | WorldsMissingResourcesEvent

    const command = new PublishCommand({
      TopicArn: snsArn,
      Message: JSON.stringify(event),
      MessageAttributes: {
        type: {
          DataType: 'String',
          StringValue: event.type
        },
        subType: {
          DataType: 'String',
          StringValue: event.subType
        }
      }
    })

    return withRetry(() => sns.send(command), 'SNS publish')
  }

  function publishBatch(
    payload:
      | PublishBatchCommand
      | Array<
          | WorldsPermissionGrantedEvent
          | WorldsPermissionRevokedEvent
          | WorldsAccessRestrictedEvent
          | WorldsAccessRestoredEvent
          | WorldsMissingResourcesEvent
        >
  ): Promise<PublishBatchCommandOutput> {
    // If it's already a PublishBatchCommand, send it directly
    if (payload instanceof PublishBatchCommand) {
      return withRetry(() => sns.send(payload), 'SNS publishBatch')
    }

    // Otherwise, treat it as an array of world content server events
    const events = payload as Array<
      | WorldsPermissionGrantedEvent
      | WorldsPermissionRevokedEvent
      | WorldsAccessRestrictedEvent
      | WorldsAccessRestoredEvent
      | WorldsMissingResourcesEvent
    >

    // Convert events to PublishBatchRequestEntries
    const entries = events.map((event, index) => ({
      Id: `${event.type}_${event.subType}_${index}`,
      Message: JSON.stringify(event),
      MessageAttributes: {
        type: {
          DataType: 'String',
          StringValue: event.type
        },
        subType: {
          DataType: 'String',
          StringValue: event.subType
        }
      }
    }))

    const command = new PublishBatchCommand({
      TopicArn: snsArn,
      PublishBatchRequestEntries: entries
    })

    return withRetry(() => sns.send(command), 'SNS publishBatch')
  }

  return {
    publish,
    publishBatch
  }
}
