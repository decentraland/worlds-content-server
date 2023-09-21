import { AppComponents, IPermissionChecker, IWorldsManager, Permissions, WorldMetadata } from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { AuthChain, Entity } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../logic/permissions-checker'

type WorldRecord = {
  name: string
  deployer: string
  entity_id: string
  deployment_auth_chain: AuthChain
  entity: any
  permissions: Permissions
  created_at: Date
  updated_at: Date
}

export async function createWorldsManagerComponent({
  logs,
  database,
  nameDenyListChecker,
  nameOwnership,
  storage
}: Pick<
  AppComponents,
  'logs' | 'database' | 'nameDenyListChecker' | 'nameOwnership' | 'storage'
>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access world ${worldName} which is banned.`)
      return undefined
    }

    const result = await database.query<WorldRecord>(
      SQL`SELECT *
              FROM worlds
              WHERE name = ${worldName.toLowerCase()}`
    )

    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]
    const tempWorldMetadata: Partial<WorldMetadata> = {}
    if (row.entity) {
      tempWorldMetadata.entityId = row.entity_id
      tempWorldMetadata.runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...row.entity, id: row.entity_id })
    }
    if (row.permissions) {
      tempWorldMetadata.permissions = row.permissions
    }

    return JSON.parse(JSON.stringify(tempWorldMetadata)) as WorldMetadata
  }

  async function deployScene(worldName: string, scene: Entity): Promise<void> {
    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const owner = await nameOwnership.findOwner(worldName)
    const fileInfos = await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size = scene.content?.reduce((acc, c) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

    const sql = SQL`
              INSERT INTO worlds (name, entity_id, owner, deployer, deployment_auth_chain, entity, size, created_at, updated_at)
              VALUES (${worldName.toLowerCase()}, ${scene.id},
                      ${owner}, ${deployer}, ${deploymentAuthChainString}::json,
                      ${scene}::json,
                      ${size},
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET entity_id = ${scene.id}, 
                                owner = ${owner},
                                deployer = ${deployer},
                                entity = ${scene}::json,
                                size = ${size},
                                deployment_auth_chain = ${deploymentAuthChainString}::json,
                                updated_at = ${new Date()}
    `
    await database.query(sql)
  }

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    const sql = SQL`
              INSERT INTO worlds (name, permissions, created_at, updated_at)
              VALUES (${worldName.toLowerCase()}, ${JSON.stringify(permissions)}::json,
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name) 
                  DO UPDATE SET permissions = ${JSON.stringify(permissions)}::json,
                                updated_at = ${new Date()}
    `
    await database.query(sql)
  }

  async function getDeployedWorldCount(): Promise<number> {
    const result = await database.query<{ count: string }>(
      'SELECT COUNT(name) AS count FROM worlds WHERE entity_id IS NOT NULL'
    )
    return parseInt(result.rows[0].count)
  }

  const mapEntity = (row: Pick<WorldRecord, 'entity_id' | 'entity'>) => ({
    ...row.entity,
    id: row.entity_id
  })

  async function getDeployedWorldEntities(): Promise<Entity[]> {
    const result = await database.query<Pick<WorldRecord, 'name' | 'entity_id' | 'entity'>>(
      'SELECT name, entity_id, entity FROM worlds WHERE entity_id IS NOT NULL ORDER BY name'
    )

    return result.rows.filter(async (row) => await nameDenyListChecker.checkNameDenyList(row.name)).map(mapEntity)
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access entity for world ${worldName} which is banned.`)
      return undefined
    }

    const result = await database.query<Pick<WorldRecord, 'entity_id' | 'entity'>>(
      SQL`SELECT entity_id, entity FROM worlds WHERE name = ${worldName.toLowerCase()} AND entity_id IS NOT NULL ORDER BY name`
    )

    if (result.rowCount === 0) {
      return undefined
    }

    return mapEntity(result.rows[0])
  }

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
  }

  return {
    getDeployedWorldCount,
    getDeployedWorldEntities,
    getMetadataForWorld,
    getEntityForWorld,
    deployScene,
    storePermissions,
    permissionCheckerForWorld
  }
}
