import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { SNS } from 'aws-sdk'

export async function reprocessABHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'sns' | 'worldsManager', '/reprocess-ab'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, logs, sns, worldsManager } = context.components
  const logger = logs.getLogger('reprocess-ab-handler')

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

  if (!sns.arn) {
    throw new Error('SNS ARN is not defined.')
  }

  const snsClient = new SNS()

  const allWorlds = await worldsManager.getRawWorldRecords()
  const mapped = allWorlds.map((world) => ({
    entity: {
      entityId: world.entity_id,
      authChain: world.deployment_auth_chain
    },
    contentServerUrls: [baseUrl]
  }))

  const receipt = await snsClient
    .publishBatch({
      TopicArn: sns.arn,
      PublishBatchRequestEntries: mapped.map((world) => ({
        Id: world.entity.entityId,
        Message: JSON.stringify(world)
      }))
    })
    .promise()

  logger.info('notification sent', {
    successful: receipt.Successful?.length || 0,
    failed: receipt.Failed?.length || 0
  })

  return {
    status: 200,
    body: {
      baseUrl,
      batch: mapped,
      successful: receipt?.Successful?.length || 0,
      failed: receipt?.Failed?.length || 0
    }
  }
}
