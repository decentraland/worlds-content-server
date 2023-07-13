import { AppComponents, DeploymentResult, IEntityDeployer } from '../types'
import { AuthLink, Entity, EntityType } from '@dcl/schemas'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'

type PostDeploymentHook = (baseUrl: string, entity: Entity, authChain: AuthLink[]) => Promise<DeploymentResult>

export function createEntityDeployer(
  components: Pick<AppComponents, 'config' | 'logs' | 'metrics' | 'storage' | 'sns'>
): IEntityDeployer {
  const { logs, storage } = components
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

    return await postDeployment(baseUrl, entity, entityJson, authChain)
  }

  const postDeploymentHooks: Partial<Record<EntityType, PostDeploymentHook>> = {
    [EntityType.SCENE]: postSceneDeployment,
    [EntityType.SKYBOX]: postSkyboxDeployment
  }

  async function postDeployment(
    baseUrl: string,
    entity: Entity,
    entityMetadataJson: any,
    authChain: AuthLink[]
  ): Promise<DeploymentResult> {
    const hookForType = postDeploymentHooks[entity.type] || noPostDeploymentHook
    return hookForType(baseUrl, entity, entityMetadataJson, authChain)
  }

  async function noPostDeploymentHook(
    _baseUrl: string,
    _entity: Entity,
    _entityMetadataJson: any,
    _authChain: AuthLink[]
  ): Promise<DeploymentResult> {
    return { message: 'No post deployment hook for this entity type' }
  }

  async function postSceneDeployment(baseUrl: string, entity: Entity, authChain: AuthLink[]) {
    const { metrics, storage, sns } = components

    // determine the name to use for deploying the world
    const worldName = entity.metadata.worldConfiguration.name
    logger.debug(`Deployment for scene "${entity.id}" under world name "${worldName}"`)

    let acl
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    if (content) {
      const stored = JSON.parse((await streamToBuffer(await content.asStream())).toString())
      acl = stored.acl
    }
    await storage.storeStream(
      `name-${worldName.toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(JSON.stringify({ entityId: entity.id, acl })))
    )

    metrics.increment('world_deployments_counter')

    // send deployment notification over sns
    if (sns.arn) {
      const deploymentToSqs: DeploymentToSqs = {
        entity: {
          entityId: entity.id,
          authChain
        },
        contentServerUrls: [baseUrl]
      }
      const snsClient = new SNSClient({})
      const command = new PublishCommand({
        TopicArn: sns.arn,
        Message: JSON.stringify(deploymentToSqs)
      })
      const receipt = await snsClient.send(command)
      logger.info('notification sent', {
        MessageId: receipt.MessageId as any,
        SequenceNumber: receipt.SequenceNumber as any
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

  async function postSkyboxDeployment(baseUrl: string, entity: Entity, _authChain: AuthLink[]) {
    await storage.storeStream(
      `skybox-${entity.pointers[0].toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(JSON.stringify({ entityId: entity.id })))
    )

    return {
      message: [
        `Your skybox was deployed to the Worlds Content Server!`,
        `It can be referenced in Worlds deployed on the same server using the urn: ${entity.pointers[0]}`
      ].join('\n')
    }
  }

  return {
    deployEntity
  }
}
