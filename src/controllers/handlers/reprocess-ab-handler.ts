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

  // Get all scenes using worldsManager
  // TODO: Get only the scenes that are in the body
  const { scenes: allScenes } = await worldsManager.getWorldScenes()

  // Filter scenes by world name if body is provided
  const filteredScenes = allScenes.filter((scene) => !body || body.includes(scene.worldName))

  // Also check the world is not in deny list
  const allowedWorlds = await worldsManager.getRawWorldRecords()
  const allowedWorldNames = new Set(allowedWorlds.map((w) => w.name))
  const validScenes = filteredScenes.filter((scene) => allowedWorldNames.has(scene.worldName))

  if (validScenes.length === 0) {
    throw new InvalidRequestError('No scenes found for reprocessing')
  }

  const mapped: WorldDeploymentEvent[] = validScenes.map((scene) => ({
    entity: {
      entityId: scene.entityId,
      authChain: scene.deploymentAuthChain
    },
    contentServerUrls: [baseUrl],
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.DEPLOYMENT,
    key: scene.entityId,
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
