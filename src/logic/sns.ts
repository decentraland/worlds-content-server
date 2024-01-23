import {
  PublishBatchCommand,
  PublishBatchCommandOutput,
  PublishCommand,
  PublishCommandOutput
} from '@aws-sdk/client-sns'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { SnsClient } from '../types'

export async function snsPublish(
  client: SnsClient,
  snsArn: string,
  deploymentToSqs: DeploymentToSqs
): Promise<PublishCommandOutput> {
  const sendCommand = new PublishCommand({
    TopicArn: snsArn,
    Message: JSON.stringify(deploymentToSqs)
  })

  return await client.publish(sendCommand)
}

export async function snsPublishBatch(
  client: SnsClient,
  snsArn: string,
  deploymentToSqs: DeploymentToSqs[]
): Promise<PublishBatchCommandOutput> {
  const sendCommand = new PublishBatchCommand({
    TopicArn: snsArn,
    PublishBatchRequestEntries: deploymentToSqs.map((world) => ({
      Id: world.entity.entityId,
      Message: JSON.stringify(world)
    }))
  })

  return await client.publishBatch(sendCommand)
}
