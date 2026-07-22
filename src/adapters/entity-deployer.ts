import { AppComponents, DeploymentFile, DeploymentResult, IEntityDeployer } from '../types'
import { AuthLink, Entity, EntityType, Events, WorldDeploymentEvent } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { getConcurrency, mapWithConcurrency } from '../logic/concurrency'

type PostDeploymentHook = (
  baseUrl: string,
  entity: Entity,
  authChain: AuthLink[],
  deploymentSize: number
) => Promise<DeploymentResult>

/** Maximum number of independent content-addressed objects uploaded concurrently. */
export const DEFAULT_STORAGE_UPLOAD_CONCURRENCY = 10

/**
 * Creates the deployment component that uploads content and commits validated scenes.
 *
 * Content objects are stored in bounded-parallel batches before the entity and auth-chain objects.
 * The already-calculated deployment size and auth chain are forwarded to the worlds manager so it
 * does not need to retrieve the same storage metadata again.
 *
 * @param components Storage, world persistence, ownership, notification, logging, and metric dependencies.
 * @returns Entity deployment component.
 */
export function createEntityDeployer(
  components: Pick<
    AppComponents,
    'blocking' | 'config' | 'logs' | 'nameOwnership' | 'metrics' | 'storage' | 'snsClient' | 'worldsManager'
  >
): IEntityDeployer {
  const { logs, storage, worldsManager } = components
  const logger = logs.getLogger('entity-deployer')
  let storageConcurrency: Promise<number> | undefined

  async function deployEntity(
    baseUrl: string,
    entity: Entity,
    allContentHashesInStorage: Map<string, boolean>,
    files: Map<string, DeploymentFile>,
    entityJson: string,
    authChain: AuthLink[],
    deploymentSize: number
  ): Promise<DeploymentResult> {
    storageConcurrency ??= getConcurrency(
      components.config,
      'DEPLOYMENT_STORAGE_CONCURRENCY',
      DEFAULT_STORAGE_UPLOAD_CONCURRENCY
    )
    const contentByHash = new Map((entity.content || []).map((file) => [file.hash, file]))
    const filesToStore = Array.from(contentByHash).filter(([hash]) => !allContentHashesInStorage.get(hash))
    logger.info(`Storing ${filesToStore.length} files`, { entityId: entity.id })

    await mapWithConcurrency(filesToStore, await storageConcurrency, async ([hash]) => {
      await storage.storeStream(hash, files.get(hash)!.getStream())
      allContentHashesInStorage.set(hash, true)
    })

    logger.info(`Storing entity`, { cid: entity.id })
    await Promise.all([
      storage.storeStream(entity.id, bufferToStream(stringToUtf8Bytes(entityJson))),
      storage.storeStream(entity.id + '.auth', bufferToStream(stringToUtf8Bytes(JSON.stringify(authChain))))
    ])

    return await postDeployment(baseUrl, entity, authChain, deploymentSize)
  }

  const postDeploymentHooks: Partial<Record<EntityType, PostDeploymentHook>> = {
    [EntityType.SCENE]: postSceneDeployment
  }

  async function postDeployment(
    baseUrl: string,
    entity: Entity,
    authChain: AuthLink[],
    deploymentSize: number
  ): Promise<DeploymentResult> {
    const hookForType = postDeploymentHooks[entity.type] || noPostDeploymentHook
    return hookForType(baseUrl, entity, authChain, deploymentSize)
  }

  async function noPostDeploymentHook(
    _baseUrl: string,
    _entity: Entity,
    _authChain: AuthLink[],
    _deploymentSize: number
  ): Promise<DeploymentResult> {
    return { message: 'No post deployment hook for this entity type' }
  }

  async function postSceneDeployment(baseUrl: string, entity: Entity, authChain: AuthLink[], deploymentSize: number) {
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

    await worldsManager.deployScene(worldName, entity, owner, { authChain, size: deploymentSize })

    // A deployment that replaces a larger scene can free enough space to bring a
    // previously-blocked owner back under quota. The check short-circuits cheaply when the
    // owner is not blocked and never throws, so a failed recheck cannot fail the deployment.
    await components.blocking.unblockIfUnderQuota(owner)

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
