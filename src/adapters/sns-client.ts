import {
  PublishBatchCommand,
  PublishBatchCommandOutput,
  PublishCommand,
  PublishCommandOutput,
  SNSClient as AwsSnsClient
} from '@aws-sdk/client-sns'
import { AppComponents, SnsClient } from '../types'

export async function createSnsClient({ awsConfig }: Pick<AppComponents, 'awsConfig'>): Promise<SnsClient> {
  const sns = new AwsSnsClient(awsConfig)

  function publish(payload: PublishCommand): Promise<PublishCommandOutput> {
    return sns.send(payload)
  }

  function publishBatch(payload: PublishBatchCommand): Promise<PublishBatchCommandOutput> {
    return sns.send(payload)
  }

  return {
    publish,
    publishBatch
  }
}
