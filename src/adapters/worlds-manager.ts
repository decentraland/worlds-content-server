import { AppComponents, IWorldsManager, WorldMetadata } from '../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { AuthChain, Entity } from '@dcl/schemas'
import { stringToUtf8Bytes } from 'eth-connect'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { deepEqual } from '../logic/deep-equal'

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
  // const logger = logs.getLogger('worlds-manager')
  // const WORLDS_KEY = 'worlds'
  //
  // const cache = new LRU<string, string[]>({
  //   max: 1,
  //   ttl: 10 * 60 * 1000, // cache for 10 minutes
  //   fetchMethod: async (_, staleValue): Promise<string[] | undefined> => {
  //     try {
  //       const worlds = []
  //       for await (const key of storage.allFileIds('name-')) {
  //         worlds.push(key.substring(5)) // remove "name-" prefix
  //       }
  //       return worlds
  //     } catch (_: any) {
  //       logger.warn(`Error retrieving worlds from storage: ${_.message}`)
  //       return staleValue
  //     }
  //   }
  // })

  // const worldsCache = new LRU<string, WorldMetadata>({
  //   max: 100,
  //   ttl: 2 * 1000, // cache for 2 seconds (should be enough for multiple accesses during the same request)
  //   fetchMethod: async (worldName, staleValue): Promise<WorldMetadata | undefined> => {}
  // })
  //
  async function getDeployedWorldsNames(): Promise<string[]> {
    const result = await pg.query('SELECT name FROM worlds ORDER BY name')
    return result.rows.map((row) => row.name)
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
    // console.log('worldName', worldName)
    const result = await pg.query<WorldRecord>(SQL`SELECT * FROM worlds WHERE name = ${worldName.toLowerCase()}`)
    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]
    const tempWorldMetadata: Partial<WorldMetadata> = {}
    if (row.entity_id) {
      tempWorldMetadata.entityId = row.entity_id
      tempWorldMetadata.runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...row.metadata, id: row.entity_id })
    }
    if (row.acl) {
      tempWorldMetadata.acl = row.acl
    }
    const fromDb: WorldMetadata = JSON.parse(JSON.stringify(tempWorldMetadata))

    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    if (!content) {
      return undefined
    }
    const fromStorage = JSON.parse((await streamToBuffer(await content.asStream())).toString())

    if (!deepEqual(fromDb, fromStorage)) {
      console.warn('fromDb', fromDb, 'fromStorage', fromStorage)
    }
    return fromStorage
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

    // worldsCache.delete(worldName)
  }

  async function deployScene(worldName: string, scene: Entity): Promise<void> {
    await storeWorldMetadata(worldName, {
      entityId: scene.id,
      runtimeMetadata: extractWorldRuntimeMetadata(worldName, scene)
    })

    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()
    // console.log({ worldName, entityId: scene.id, deployer, deploymentAuthChain })

    const sql = SQL`
              INSERT INTO worlds (name, entity_id, deployer, deployment_auth_chain, metadata, created_at, updated_at)
              VALUES (${worldName}, ${scene.id}, ${deployer}, ${deploymentAuthChainString}::json,
                      ${scene.metadata}::json,
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET entity_id = ${scene.id}, 
                                deployer = ${deployer},
                                metadata = ${scene.metadata}::json,
                                deployment_auth_chain = ${deploymentAuthChainString}::json,
                                updated_at = ${new Date()}
                `
    // console.log('sql', sql.sql)
    // console.log('query', sql.query)
    // console.log('values', sql.values)
    await pg.query(sql).catch((error) => {
      console.log('error', error)
      throw error
    })
  }

  async function storeAcl(worldName: string, acl: AuthChain): Promise<void> {
    const sql = SQL`
              INSERT INTO worlds (name, acl, created_at, updated_at)
              VALUES (${worldName}, ${JSON.stringify(acl)}::json, ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET acl = ${JSON.stringify(acl)}::json, updated_at = ${new Date()}
                `
    await pg.query(sql)

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
