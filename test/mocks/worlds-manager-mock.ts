import { AppComponents, IPermissionChecker, IWorldsManager, Permissions, WorldMetadata } from '../../src/types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { Entity } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { extractWorldRuntimeMetadata } from '../../src/logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../../src/logic/permissions-checker'

export async function createWorldsManagerMockComponent({
  storage
}: Pick<AppComponents, 'storage'>): Promise<IWorldsManager> {
  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    const metadata = await getMetadataForWorld(worldName)
    if (!metadata || !metadata.entityId) {
      return undefined
    }

    const content = await storage.retrieve(metadata.entityId)
    if (!content) {
      return undefined
    }

    const json = JSON.parse((await streamToBuffer(await content?.asStream())).toString())

    return {
      ...json,
      id: metadata.entityId
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
      entityId: scene.id,
      runtimeMetadata: extractWorldRuntimeMetadata(worldName, scene)
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

  return {
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
