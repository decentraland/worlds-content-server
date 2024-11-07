import {
  AppComponents,
  ContributorDomain,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  SceneRecord,
  WorldMetadata
} from '../../src/types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { Entity } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { extractWorldRuntimeMetadata } from '../../src/logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../../src/logic/permissions-checker'

export async function createWorldsManagerMockComponent({
  storage
}: Pick<AppComponents, 'storage'>): Promise<IWorldsManager> {
  async function getRawSceneRecords(): Promise<SceneRecord[]> {
    const scenes: SceneRecord[] = []
    for await (const key of storage.allFileIds('name-')) {
      const metadata = await getMetadataForWorld(key)
      if (!metadata || metadata.runtimeMetadata.entityIds.length === 0) {
        continue
      }
      for (const entityId of metadata.runtimeMetadata.entityIds) {
        const content = await storage.retrieve(entityId)
        if (!content) {
          continue
        }

        const json = JSON.parse((await streamToBuffer(await content.asStream())).toString())
        const authChainText = await storage.retrieve(`${entityId}.auth`)
        const authChain = JSON.parse((await streamToBuffer(await authChainText?.asStream())).toString())

        scenes.push({
          world_name: key,
          entity_id: entityId,
          entity: json,
          deployment_auth_chain: authChain,
          deployer: authChain[0].payload,
          size: 0n
        })
      }
    }
    return scenes
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    const metadata = await getMetadataForWorld(worldName)
    if (
      !metadata ||
      !metadata.runtimeMetadata ||
      !metadata.runtimeMetadata.entityIds ||
      metadata.runtimeMetadata.entityIds.length === 0
    ) {
      return undefined
    }

    const content = await storage.retrieve(metadata.runtimeMetadata.entityIds[0])
    if (!content) {
      return undefined
    }

    const json = JSON.parse((await streamToBuffer(await content?.asStream())).toString())

    return {
      ...json,
      id: metadata.runtimeMetadata.entityIds[0]
    }
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    if (!content) {
      return undefined
    }
    return JSON.parse((await streamToBuffer(await content.asStream())).toString())
  }

  async function storeWorldMetadata(worldName: string, worldMetadata: Partial<WorldMetadata>): Promise<void> {
    const contentMetadata = (await getMetadataForWorld(worldName.toLowerCase())) || {}
    const metadata: Partial<WorldMetadata> = Object.assign({}, contentMetadata, worldMetadata)
    Object.assign(metadata, worldMetadata)

    await storage.storeStream(
      `name-${worldName.toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(JSON.stringify(metadata)))
    )
  }

  async function deployScene(worldName: string, scene: Entity): Promise<void> {
    await storeWorldMetadata(worldName, {
      runtimeMetadata: extractWorldRuntimeMetadata(worldName, [scene])
    })
  }

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    await storeWorldMetadata(worldName, { permissions })
  }

  async function getDeployedWorldCount(): Promise<{ ens: number; dcl: number }> {
    const acc = { ens: 0, dcl: 0 }
    for await (const name of storage.allFileIds('name-')) {
      if (name.endsWith('.dcl.eth')) {
        acc.dcl++
      } else {
        acc.ens++
      }
    }
    return acc
  }

  async function getDeployedWorldEntities(): Promise<Entity[]> {
    const worlds: Entity[] = []
    for await (const key of storage.allFileIds('name-')) {
      const entity = await getEntityForWorld(key.substring(5))
      if (entity) {
        worlds.push(entity)
      }
    }
    return worlds
  }

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
  }

  async function undeploy(worldName: string): Promise<void> {
    await storage.delete([`name-${worldName.toLowerCase()}`])
  }

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    const domains: ContributorDomain[] = []
    for await (const name of storage.allFileIds('name-')) {
      const metadata = await getMetadataForWorld(name)
      const entity = await getEntityForWorld(name)
      if (entity) {
        const content = await storage.retrieve(`${entity.id}.auth`)
        const authChain = JSON.parse((await streamToBuffer(await content?.asStream())).toString())
        const hasDeploymentPermission = metadata.permissions.deployment.wallets.includes(address)
        const hasStreamingPermission =
          'wallets' in metadata.permissions.streaming && metadata.permissions.streaming.wallets.includes(address)
        if (hasStreamingPermission || hasStreamingPermission) {
          domains.push({
            name,
            user_permissions: [
              ...(hasDeploymentPermission ? ['deployment'] : []),
              ...(hasStreamingPermission ? ['streaming'] : [])
            ],
            size: '0',
            owner: authChain[0].payload
          })
        }
      }
    }
    return { domains, count: domains.length }
  }

  return {
    getContributableDomains,
    getRawSceneRecords,
    getDeployedWorldCount,
    getDeployedWorldEntities,
    getMetadataForWorld,
    getEntityForWorld,
    deployScene,
    storePermissions,
    permissionCheckerForWorld,
    undeploy
  }
}
