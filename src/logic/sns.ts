import { PublishBatchCommand, PublishCommand, PublishCommandOutput } from '@aws-sdk/client-sns'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { SnsClient } from '../types'
import { chunks } from './utils'
import { PublishBatchResponse } from '@aws-sdk/client-sns/dist-types/models/models_0'
import { Events } from '@dcl/schemas'

export async function snsPublish(
  client: SnsClient,
  snsArn: string,
  deploymentToSqs: DeploymentToSqs
): Promise<PublishCommandOutput> {
  const sendCommand = new PublishCommand({
    TopicArn: snsArn,
    Message: JSON.stringify(deploymentToSqs),
    MessageAttributes: {
      type: {
        DataType: 'String',
        StringValue: Events.Type.WORLD
      },
      subType: {
        DataType: 'String',
        StringValue: Events.SubType.Worlds.DEPLOYMENT
      },
      priority: {
        DataType: 'String',
        StringValue: '1'
      }
    }
  })

  return await client.publish(sendCommand)
}

export async function snsPublishBatch(
  client: SnsClient,
  snsArn: string,
  deploymentToSqs: DeploymentToSqs[]
): Promise<PublishBatchResponse> {
  const result: PublishBatchResponse = {
    Successful: [],
    Failed: []
  }

  const chunkedDeploymentToSqs = chunks(deploymentToSqs, 10)
  for (const batch of chunkedDeploymentToSqs) {
    const sendCommand = new PublishBatchCommand({
      TopicArn: snsArn,
      PublishBatchRequestEntries: batch.map((world) => ({
        Id: world.entity.entityId,
        Message: JSON.stringify(world),
        MessageAttributes: {
          type: {
            DataType: 'String',
            StringValue: Events.Type.WORLD
          },
          subType: {
            DataType: 'String',
            StringValue: Events.SubType.Worlds.DEPLOYMENT
          }
        }
      }))
    })

    const publishBatchCommandOutput = await client.publishBatch(sendCommand)
    result.Successful?.push(...(publishBatchCommandOutput.Successful || []))
    result.Failed?.push(...(publishBatchCommandOutput.Failed || []))
  }

  return result
}
