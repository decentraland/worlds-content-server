import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { SNS } from 'aws-sdk'

export async function reprocessABHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'sns' | 'worldsManager', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, logs, sns, worldsManager } = context.components
  const logger = logs.getLogger('reprocess-ab-handler')

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

  if (!sns.arn) {
    throw new Error('SNS ARN is not defined.')
  }

  const awsConfig: any = {
    region: await config.requireString('AWS_REGION'),
    endpoint: await config.getString('AWS_ENDPOINT'),
    s3ForcePathStyle: true
  }

  const accessKeyId = await config.getString('AWS_ACCESS_KEY_ID')
  const secretAccessKey = await config.getString('AWS_SECRET_ACCESS_KEY')
  if (accessKeyId && secretAccessKey) {
    awsConfig.credentials = {
      accessKeyId: (await config.getString('AWS_ACCESS_KEY_ID')) || '',
      secretAccessKey: (await config.getString('AWS_SECRET_ACCESS_KEY')) || ''
    }
  }

  const snsClient = new SNS(awsConfig)

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
    .catch(console.error)

  logger.info('notification sent', {
    successful: receipt?.Successful?.length || 0,
    failed: receipt?.Failed?.length || 0
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
