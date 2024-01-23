import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { snsPublishBatch } from '../../logic/sns'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export async function reprocessABHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'snsClient' | 'worldsManager', '/reprocess-ab'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, logs, snsClient, worldsManager } = context.components
  const logger = logs.getLogger('reprocess-ab-handler')
  const snsArn = await config.getString('SNS_ARN')

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

  if (!snsArn) {
    throw new Error('SNS ARN is not defined.')
  }

  const body = await context.request
    .json()
    .then((name) => name.map((s: string) => s.toLowerCase()))
    .catch((_) => undefined)

  const allWorlds = await worldsManager.getRawWorldRecords()
  const filteredWorlds = allWorlds
    .filter((world) => !body || body.includes(world.name))
    .filter((world) => world.entity_id !== null)
  if (filteredWorlds.length === 0) {
    throw new InvalidRequestError('No worlds found for reprocessing')
  }

  const mapped: DeploymentToSqs[] = filteredWorlds.map((world) => ({
    entity: {
      entityId: world.entity_id,
      authChain: world.deployment_auth_chain
    },
    contentServerUrls: [baseUrl]
  }))
  const result = await snsPublishBatch(snsClient, snsArn, mapped)
  logger.info('notification sent', {
    successful: result.Successful?.length || 0,
    failed: result.Failed?.length || 0
  })

  return {
    status: 200,
    body: {
      baseUrl,
      batch: mapped,
      successful: result.Successful?.length || 0,
      failed: result.Failed?.length || 0
    }
  }
}
