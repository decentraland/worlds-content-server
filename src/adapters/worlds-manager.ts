import { AccessControlList, AppComponents, IWorldsManager, WorldMetadata } from '../types'
import LRU from 'lru-cache'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { AuthChain, Entity, EthAddress } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'

export async function createWorldsManagerComponent({
  logs,
  namePermissionChecker,
  storage
}: Pick<AppComponents, 'logs' | 'storage' | 'namePermissionChecker'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')
  const WORLDS_KEY = 'worlds'
  const cache = new LRU<string, string[]>({
    max: 1,
    ttl: 10 * 60 * 1000, // cache for 10 minutes
    fetchMethod: async (_, staleValue): Promise<string[]> => {
      try {
        const worlds = []
        for await (const key of await storage.allFileIds('name-')) {
          worlds.push(key.substring(5)) // remove "name-" prefix
        }
        return worlds
      } catch (_: any) {
        logger.warn(`Error retrieving worlds from storage: ${_.message}`)
        return staleValue
      }
    }
  })
  const worldsCache = new LRU<string, WorldMetadata>({
    max: 100,
    ttl: 10 * 60 * 1000, // cache for 10 minutes
    fetchMethod: async (worldName, staleValue): Promise<WorldMetadata | undefined> => {
      const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
      if (!content) {
        return staleValue
      }
      return JSON.parse((await streamToBuffer(await content.asStream())).toString())
    }
  })

  async function getDeployedWorldsNames(): Promise<string[]> {
    return (await cache.fetch(WORLDS_KEY))!
  }

  async function getDeployedWorldsCount(): Promise<number> {
    return (await cache.fetch(WORLDS_KEY))?.length || 0
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    const entityId = await getEntityIdForWorld(worldName)
    if (!entityId) {
      return undefined
    }

    const content = await storage.retrieve(entityId)
    if (!content) {
      return undefined
    }

    const json = JSON.parse((await streamToBuffer(await content?.asStream())).toString())

    return {
      // the timestamp is not stored int the entity :/
      timestamp: 0,
      ...json,
      id: entityId
    }
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    return await worldsCache.fetch(worldName)
  }

  async function getEntityIdForWorld(worldName: string): Promise<string | undefined> {
    const content = await worldsCache.fetch(worldName)
    if (!content) {
      return undefined
    }

    const { entityId } = content

    return entityId
  }

  async function allowedByAcl(worldName: string, address: EthAddress): Promise<boolean> {
    const worldMetadata = await getMetadataForWorld(worldName)
    if (!worldMetadata || !worldMetadata.acl) {
      // No acl -> no permission
      return false
    }

    const acl = JSON.parse(worldMetadata.acl.slice(-1).pop()!.payload) as AccessControlList
    const isAllowed = acl.allowed.some((allowedAddress) => allowedAddress.toLowerCase() === address.toLowerCase())
    if (!isAllowed) {
      // There is acl but requested address is not included in the allowed ones
      return false
    }

    // The acl allows permissions, finally check that the signer of the acl still owns the world
    const aclSigner = worldMetadata.acl[0].payload
    return namePermissionChecker.checkPermission(aclSigner, worldName)
  }

  async function storeAcl(worldName: string, acl: AuthChain): Promise<void> {
    const content = await worldsCache.fetch(worldName)
    const { entityId } = content!

    await storage.storeStream(
      `name-${worldName}`,
      bufferToStream(
        stringToUtf8Bytes(
          JSON.stringify({
            entityId,
            acl: acl
          })
        )
      )
    )
    worldsCache.delete(worldName)
  }

  return {
    getDeployedWorldsNames,
    getDeployedWorldsCount,
    getMetadataForWorld,
    getEntityIdForWorld,
    getEntityForWorld,
    allowedByAcl,
    storeAcl
  }
}
