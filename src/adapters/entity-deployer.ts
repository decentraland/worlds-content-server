import { AppComponents, DeploymentResult, IEntityDeployer } from '../types'
import { AuthLink, Entity, EntityType, Events, WorldDeploymentEvent } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'

type PostDeploymentHook = (baseUrl: string, entity: Entity, authChain: AuthLink[]) => Promise<DeploymentResult>

export function createEntityDeployer(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
  >
): IEntityDeployer {
  const { logs, storage, worldsManager } = components
  const logger = logs.getLogger('entity-deployer')

  async function deployEntity(
    baseUrl: string,
    entity: Entity,
    allContentHashesInStorage: Map<string, boolean>,
    files: Map<string, Uint8Array>,
    entityJson: string,
    authChain: AuthLink[]
  ): Promise<DeploymentResult> {
    // store all files
    const content = entity.content || []
    logger.info(`Storing ${content.length} files`, { entityId: entity.id })
    for (const file of content) {
      if (!allContentHashesInStorage.get(file.hash)) {
        const filename = content.find(($) => $.hash === file.hash)
        logger.info(`Storing file`, { cid: file.hash, filename: filename?.file || 'unknown' })
        await storage.storeStream(file.hash, bufferToStream(files.get(file.hash)!))
        allContentHashesInStorage.set(file.hash, true)
      }
    }

    logger.info(`Storing entity`, { cid: entity.id })
    await Promise.all([
      storage.storeStream(entity.id, bufferToStream(stringToUtf8Bytes(entityJson))),
      storage.storeStream(entity.id + '.auth', bufferToStream(stringToUtf8Bytes(JSON.stringify(authChain))))
    ])

    return await postDeployment(baseUrl, entity, authChain)
  }

  const postDeploymentHooks: Partial<Record<EntityType, PostDeploymentHook>> = {
    [EntityType.SCENE]: postSceneDeployment
  }

  async function postDeployment(baseUrl: string, entity: Entity, authChain: AuthLink[]): Promise<DeploymentResult> {
    const hookForType = postDeploymentHooks[entity.type] || noPostDeploymentHook
    return hookForType(baseUrl, entity, authChain)
  }

  async function noPostDeploymentHook(
    _baseUrl: string,
    _entity: Entity,
    _authChain: AuthLink[]
  ): Promise<DeploymentResult> {
    return { message: 'No post deployment hook for this entity type' }
  }

  async function postSceneDeployment(baseUrl: string, entity: Entity, authChain: AuthLink[]) {
    const { config, metrics, snsClient } = components

    // determine the name to use for deploying the world
    const worldName = entity.metadata.worldConfiguration.name
    const parcels = entity.metadata?.scene?.parcels || []
    logger.debug(`Deployment for scene "${entity.id}" under world name "${worldName}" at parcels ${parcels.join(', ')}`)

    const owner = (await components.nameOwnership.findOwners([worldName])).get(worldName)

    if (!owner) {
      throw new Error(
        `Cannot deploy scene "${entity.id}" to world "${worldName}": owner address could not be resolved.`
      )
    }

    await worldsManager.deployScene(worldName, entity, owner)

    const kind = worldName.endsWith('dcl.eth') ? 'dcl-name' : 'ens-name'
    metrics.increment('world_deployments_counter', { kind })

    // send deployment notification over sns
    const snsArn = await config.getString('AWS_SNS_ARN')
    if (snsArn) {
      const deploymentToSqs: WorldDeploymentEvent = {
        entity: {
          entityId: entity.id,
          authChain
        },
        contentServerUrls: [baseUrl],
        type: Events.Type.WORLD,
        subType: Events.SubType.Worlds.DEPLOYMENT,
        key: entity.id,
        timestamp: Date.now()
      }
      const isMultiplayer = !!entity.metadata?.multiplayerId
      const receipt = await snsClient.publishMessage(deploymentToSqs, {
        isMultiplayer: { DataType: 'String', StringValue: isMultiplayer ? 'true' : 'false' },
        priority: { DataType: 'String', StringValue: '1' }
      })
      logger.info('notification sent', {
        MessageId: `${receipt.MessageId}`,
        SequenceNumber: `${receipt.SequenceNumber}`,
        isMultiplayer: isMultiplayer ? 'true' : 'false'
      })
    }

    const worldUrl = `${baseUrl}/world/${worldName}`
    // Use the first parcel as the position
    const position = parcels[0].split(',')
    return {
      message: [
        `Your scene was deployed to World "${worldName}" at parcels: ${parcels.join(', ')}!`,
        `Access world: https://play.decentraland.org/?realm=${encodeURIComponent(worldUrl)}&position=${encodeURIComponent(position.join(','))}`
      ].join('\n')
    }
  }

  return {
    deployEntity
  }
}
