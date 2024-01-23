import { AppComponents, DeploymentResult, IEntityDeployer } from '../types'
import { AuthLink, Entity, EntityType } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { snsPublish } from '../logic/sns'

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
    for (const file of entity.content!) {
      if (!allContentHashesInStorage.get(file.hash)) {
        const filename = entity.content!.find(($) => $.hash === file.hash)
        logger.info(`Storing file`, { cid: file.hash, filename: filename?.file || 'unknown' })
        await storage.storeStream(file.hash, bufferToStream(files.get(file.hash)!))
        allContentHashesInStorage.set(file.hash, true)
      }
    }

    logger.info(`Storing entity`, { cid: entity.id })
    await storage.storeStream(entity.id, bufferToStream(stringToUtf8Bytes(entityJson)))
    await storage.storeStream(entity.id + '.auth', bufferToStream(stringToUtf8Bytes(JSON.stringify(authChain))))

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
    logger.debug(`Deployment for scene "${entity.id}" under world name "${worldName}"`)

    const owner = (await components.nameOwnership.findOwners([worldName])).get(worldName)

    await worldsManager.deployScene(worldName, entity, owner!)

    const kind = worldName.endsWith('dcl.eth') ? 'dcl-name' : 'ens-name'
    metrics.increment('world_deployments_counter', { kind })

    // send deployment notification over sns
    const snsArn = await config.getString('SNS_ARN')
    if (snsArn) {
      const deploymentToSqs: DeploymentToSqs = {
        entity: {
          entityId: entity.id,
          authChain
        },
        contentServerUrls: [baseUrl]
      }
      const receipt = await snsPublish(snsClient, snsArn, deploymentToSqs)
      logger.info('notification sent', {
        MessageId: `${receipt.MessageId}`,
        SequenceNumber: `${receipt.SequenceNumber}`
      })
    }

    const worldUrl = `${baseUrl}/world/${worldName}`
    return {
      message: [
        `Your scene was deployed to a Worlds Content Server!`,
        `Access world ${worldName}: https://play.decentraland.org/?realm=${encodeURIComponent(worldUrl)}`
      ].join('\n')
    }
  }

  return {
    deployEntity
  }
}
