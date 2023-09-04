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
  entity: any
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
    const result = await pg.query<WorldRecord>(SQL`SELECT * FROM worlds WHERE name = ${worldName.toLowerCase()}`)

    if (result.rowCount === 0) {
      const isInStorage = await storage.exist(`name-${worldName.toLowerCase()}`)
      if (isInStorage) {
        logger.warn(`World ${worldName} not found in DB but file exists in storage.`)
      }
      return undefined
    }

    const row = result.rows[0]
    const tempWorldMetadata: Partial<WorldMetadata> = {}
    if (row.entity) {
      tempWorldMetadata.entityId = row.entity_id
      tempWorldMetadata.runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...row.entity, id: row.entity_id })
    }
    if (row.acl) {
      tempWorldMetadata.acl = row.acl
    }
    const fromDb = JSON.parse(JSON.stringify(tempWorldMetadata)) as WorldMetadata

    // Run checks against storage until we're sure the DB is in sync
    {
      const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
      if (!content) {
        return undefined
      }
      const fromStorage = JSON.parse((await streamToBuffer(await content.asStream())).toString())

      if (!deepEqual(fromDb, fromStorage)) {
        console.warn('fromDb', fromDb, 'fromStorage', fromStorage)
      }
    }

    return fromDb
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
  }

  async function deployScene(worldName: string, scene: Entity): Promise<void> {
    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const sql = SQL`
              INSERT INTO worlds (name, entity_id, deployer, deployment_auth_chain, entity, created_at, updated_at)
              VALUES (${worldName}, ${scene.id}, ${deployer}, ${deploymentAuthChainString}::json,
                      ${scene}::json,
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET entity_id = ${scene.id}, 
                                deployer = ${deployer},
                                entity = ${scene}::json,
                                deployment_auth_chain = ${deploymentAuthChainString}::json,
                                updated_at = ${new Date()}
    `
    await pg.query(sql)

    // TODO remove once we are sure everything works fine with DB
    await storeWorldMetadata(worldName, {
      entityId: scene.id,
      runtimeMetadata: extractWorldRuntimeMetadata(worldName, scene)
    })
  }

  async function storeAcl(worldName: string, acl: AuthChain): Promise<void> {
    const sql = SQL`
              INSERT INTO worlds (name, acl, created_at, updated_at)
              VALUES (${worldName}, ${JSON.stringify(acl)}::json, ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET acl = ${JSON.stringify(acl)}::json,
                                updated_at = ${new Date()}
    `
    await pg.query(sql)

    // TODO remove once we are sure everything works fine with DB
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
