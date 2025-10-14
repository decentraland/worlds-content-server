import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/platform-server-commons'
import { Events, WorldDeploymentEvent } from '@dcl/schemas'

export async function reprocessABHandler(
  context: HandlerContextWithPath<'config' | 'logs' | 'snsClient' | 'worldsManager', '/reprocess-ab'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, logs, snsClient, worldsManager } = context.components
  const logger = logs.getLogger('reprocess-ab-handler')
  const snsArn = await config.getString('AWS_SNS_ARN')

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

  const mapped: WorldDeploymentEvent[] = filteredWorlds.map((world) => ({
    entity: {
      entityId: world.entity_id,
      authChain: world.deployment_auth_chain
    },
    contentServerUrls: [baseUrl],
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.DEPLOYMENT,
    key: world.entity_id,
    timestamp: Date.now()
  }))
  const result = await snsClient.publishMessages(mapped)
  logger.info('notification sent', {
    successful: result.successfulMessageIds.length || 0,
    failed: result.failedEvents.length || 0
  })

  return {
    status: 200,
    body: {
      baseUrl,
      batch: mapped.map((event) => ({
        entity: event.entity,
        contentServerUrls: event.contentServerUrls
      })),
      successful: result.successfulMessageIds.length || 0,
      failed: result.failedEvents.length || 0
    }
  }
}
