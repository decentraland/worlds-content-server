import { AppComponents, IWorldsManager, WorldMetadata } from '../types'
import LRU from 'lru-cache'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { Entity } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import { migrateMetadata } from '../logic/world-metadata-migrator'

export async function createWorldsManagerComponent({
  logs,
  storage
}: Pick<AppComponents, 'logs' | 'storage'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')
  const WORLDS_KEY = 'worlds'

  const cache = new LRU<string, string[]>({
    max: 1,
    ttl: 10 * 60 * 1000, // cache for 10 minutes
    fetchMethod: async (_, staleValue): Promise<string[] | undefined> => {
      try {
        const worlds = []
        for await (const key of storage.allFileIds('name-')) {
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
    ttl: 2 * 1000, // cache for 2 seconds (should be enough for multiple accesses during the same request)
    fetchMethod: async (worldName, staleValue): Promise<WorldMetadata | undefined> => {
      const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
      if (!content) {
        return staleValue
      }
      return migrateMetadata(worldName, JSON.parse((await streamToBuffer(await content.asStream())).toString()))
    }
  })

  async function getDeployedWorldsNames(): Promise<string[]> {
    return (await cache.fetch(WORLDS_KEY))!
  }

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
      // the timestamp is not stored in the entity :/
      timestamp: 0,
      ...json,
      id: metadata.entityId
    }
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    const worldMetadata = await worldsCache.fetch(worldName)
    if (!worldMetadata) {
      return undefined
    }
    return migrateMetadata(worldName, worldMetadata)
  }

  async function storeWorldMetadata(worldName: string, worldMetadata: Partial<WorldMetadata>): Promise<void> {
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    const metadata: Partial<WorldMetadata> = {}
    if (content) {
      migrateMetadata(
        worldName,
        Object.assign(metadata, JSON.parse((await streamToBuffer(await content.asStream())).toString()))
      )
    }
    Object.assign(metadata, worldMetadata)

    await storage.storeStream(
      `name-${worldName.toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(JSON.stringify(metadata)))
    )

    worldsCache.delete(worldName)
  }

  return {
    getDeployedWorldsNames,
    getMetadataForWorld,
    getEntityForWorld,
    storeWorldMetadata
  }
}
