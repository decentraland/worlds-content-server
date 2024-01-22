import {
  PublishBatchCommand,
  PublishBatchCommandOutput,
  PublishCommand,
  PublishCommandOutput
} from '@aws-sdk/client-sns'
import { SNSClient as AwsSnsClient } from '@aws-sdk/client-sns'
import { AppComponents } from '../types'

export type SnsClient = {
  publish(payload: PublishCommand): Promise<PublishCommandOutput>
  publishBatch(payload: PublishBatchCommand): Promise<PublishBatchCommandOutput>
}

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
