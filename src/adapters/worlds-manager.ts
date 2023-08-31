import { AppComponents, IWorldsManager, WorldMetadata } from '../types'
import LRU from 'lru-cache'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { AuthChain, Entity } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'

type WorldRecord = {
  name: string
  owner: string
  deployer: string
  entity_id: string
  deployment_auth_chain: AuthChain
  metadata: any
  acl: any
  created_at: Date
  updated_at: Date
}

export async function createWorldsManagerComponent({
  logs,
  pg,
  storage
}: Pick<AppComponents, 'logs' | 'pg' | 'storage'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')
  const WORLDS_KEY = 'worlds'

  const cache = new LRU<string, string[]>({
    max: 1,
    ttl: 10 * 60 * 1000, // cache for 10 minutes
    fetchMethod: async (_, staleValue): Promise<string[] | undefined> => {
      // try {
      //   const result = await pg.query('SELECT name FROM worlds ORDER BY name')
      //   return result.rows.map((row) => row.name)
      // } catch (_: any) {
      //   logger.warn(`Error retrieving worlds from db: ${_.message}`)
      //   return staleValue
      // }
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
      console.log('worldName', worldName)
      const result = await pg.query<WorldRecord>(SQL`SELECT * FROM worlds WHERE name = ${worldName.toLowerCase()}`)
      if (result.rowCount === 0) {
        return undefined
      }

      const row = result.rows[0]
      const runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...row.metadata, id: row.entity_id })

      const fromDb: WorldMetadata = JSON.parse(
        JSON.stringify({
          entityId: row.entity_id,
          runtimeMetadata,
          acl: row.acl || undefined
        })
      )
      console.log('fromDb', fromDb)

      const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
      if (!content) {
        return staleValue
      }
      const fromStorage = JSON.parse((await streamToBuffer(await content.asStream())).toString())

      if (fromDb !== fromStorage) {
        console.log('fromStorage', fromStorage)
      }
      return fromStorage
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
    return await worldsCache.fetch(worldName)
  }

  async function storeWorldMetadata(worldName: string, worldMetadata: Partial<WorldMetadata>): Promise<void> {
    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    const contentMetadata = content ? JSON.parse((await streamToBuffer(await content.asStream())).toString()) : {}
    const metadata: Partial<WorldMetadata> = Object.assign({}, contentMetadata, worldMetadata)
    Object.assign(metadata, worldMetadata)

    await storage.storeStream(
      `name-${worldName.toLowerCase()}`,
      bufferToStream(stringToUtf8Bytes(JSON.stringify(metadata)))
    )

    worldsCache.delete(worldName)
  }

  async function deployScene(worldName: string, scene: Entity): Promise<void> {
    await storeWorldMetadata(worldName, {
      entityId: scene.id,
      runtimeMetadata: extractWorldRuntimeMetadata(worldName, scene)
    })
  }

  async function storeAcl(worldName: string, acl: AuthChain): Promise<void> {
    await storeWorldMetadata(worldName, { acl })
  }

  return {
    getDeployedWorldsNames,
    getMetadataForWorld,
    getEntityForWorld,
    deployScene,
    storeAcl
  }
}
