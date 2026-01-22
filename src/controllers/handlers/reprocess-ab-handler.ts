import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/platform-server-commons'
import { Events, WorldDeploymentEvent } from '@dcl/schemas'
import { ReprocessABInput } from '../schemas/reprocess-ab-schemas'

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

  // Body is validated by schema middleware
  const body = (await context.request.json()) as ReprocessABInput

  // Create a map of world names to their optional entity IDs for filtering
  const worldsToProcess = new Map<string, string[] | undefined>(
    body.worlds.map((w) => [w.worldName.toLowerCase(), w.entityIds])
  )

  // Get scenes for the specified worlds
  const { scenes: allScenes } = await worldsManager.getWorldScenes()

  // Filter scenes by world name and optionally by entity IDs
  const filteredScenes = allScenes.filter((scene) => {
    if (!worldsToProcess.has(scene.worldName)) {
      return false
    }
    const entityIds = worldsToProcess.get(scene.worldName)
    // If entityIds are specified, only include scenes with matching entity IDs
    if (entityIds && entityIds.length > 0) {
      return entityIds.includes(scene.entityId)
    }
    return true
  })

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
