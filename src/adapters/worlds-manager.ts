import {
  AppComponents,
  ContributorDomain,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  SceneRecord,
  WorldMetadata,
  WorldRecord
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../logic/permissions-checker'

export async function createWorldsManagerComponent({
  logs,
  database,
  nameDenyListChecker,
  storage
}: Pick<AppComponents, 'logs' | 'database' | 'nameDenyListChecker' | 'storage'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')

  async function getRawSceneRecords(): Promise<SceneRecord[]> {
    const result = await database.query<SceneRecord>(SQL`SELECT * FROM scenes`)

    const filtered: SceneRecord[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.world_name)) {
        filtered.push(row)
      }
    }

    return filtered
  }

  async function getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access world ${worldName} which is banned.`)
      return undefined
    }

    type Record = WorldRecord & Pick<SceneRecord, 'entity_id' | 'entity'>
    const result = await database.query<Record>(SQL`
        SELECT worlds.*, scenes.entity_id, scenes.entity, blocked.created_at AS blocked_since
        FROM worlds
                 JOIN scenes ON worlds.name = scenes.world_name
                 LEFT JOIN blocked ON worlds.owner = blocked.wallet
        WHERE worlds.name = ${worldName.toLowerCase()}
        ORDER BY scenes.created_at
    `)

    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]
    const tempWorldMetadata: Partial<WorldMetadata> = {}
    if (row.entity) {
      tempWorldMetadata.runtimeMetadata = extractWorldRuntimeMetadata(
        worldName,
        result.rows.map((row) => ({ ...row.entity, id: row.entity_id }))
      )
    }
    if (row.permissions) {
      tempWorldMetadata.permissions = row.permissions
    }
    if (row.blocked_since) {
      tempWorldMetadata.blockedSince = row.blocked_since
    }

    return {
      ...JSON.parse(JSON.stringify(tempWorldMetadata)),
      // this field is treated separately so that it does not get serialized to string
      blockedSince: tempWorldMetadata.blockedSince ? new Date(tempWorldMetadata.blockedSince) : undefined
    } as WorldMetadata
  }

  async function deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void> {
    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const fileInfos = await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size = scene.content?.reduce((acc, c) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

    const existingScenes = await getDeployedScenesForWorld(worldName)
    const collidingScenes = await findCollisions(scene, existingScenes)

    try {
      await database.query(SQL`BEGIN`)
      await database.query(
        SQL`DELETE
            FROM scenes
            WHERE world_name = ${worldName.toLowerCase()}
              AND entity_id = ANY (${collidingScenes.map((s) => s.entity_id)})`
      )

      const sqlWorld = SQL`
        INSERT INTO worlds (name, owner, permissions, created_at, updated_at)
        VALUES (${worldName.toLowerCase()},
                ${owner?.toLowerCase()},
                ${JSON.stringify(defaultPermissions())}::json,
                ${new Date()},
                ${new Date()})
        ON CONFLICT (name)
            DO UPDATE SET owner      = ${owner?.toLowerCase()},
                          updated_at = ${new Date()}
    `
      await database.query(sqlWorld)

      const sqlScene = SQL`
        INSERT INTO scenes (world_name, entity_id, deployer, deployment_auth_chain, entity, size, created_at, updated_at)
        VALUES (${worldName.toLowerCase()},
                ${scene.id},
                ${deployer},
                ${deploymentAuthChainString}::json,
                ${scene}::json,
                ${size},
                ${new Date()},
                ${new Date()})
        ON CONFLICT (world_name, entity_id)
            DO UPDATE SET entity_id             = ${scene.id},
                          deployer              = ${deployer},
                          deployment_auth_chain = ${deploymentAuthChainString}::json,
                          entity                = ${scene}::json,
                          size                  = ${size},
                          updated_at            = ${new Date()}
    `
      await database.query(sqlScene)
      await database.query(SQL`COMMIT`)
    } catch (error: any) {
      logger.warn(`Error deploying scene: ${error.message}`)
      await database.query(SQL`ROLLBACK`)
      throw error
    }
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

  async function getDeployedWorldCount(): Promise<{ ens: number; dcl: number }> {
    const result = await database.query<Pick<SceneRecord, 'world_name'>>('SELECT DISTINCT world_name FROM scenes')
    return result.rows.reduce(
      (acc, row) => {
        if (row.world_name.endsWith('.dcl.eth')) {
          acc.dcl++
        } else {
          acc.ens++
        }
        return acc
      },
      { ens: 0, dcl: 0 }
    )
  }

  const mapEntity = (row: Pick<SceneRecord, 'entity_id' | 'entity'>) => ({
    ...row.entity,
    id: row.entity_id
  })

  async function getDeployedWorldEntities(): Promise<Entity[]> {
    const result = await database.query<Pick<SceneRecord, 'world_name' | 'entity_id' | 'entity'>>(
      'SELECT world_name, entity_id, entity FROM scenes ORDER BY world_name'
    )

    const filtered: Pick<SceneRecord, 'world_name' | 'entity_id' | 'entity'>[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.world_name)) {
        filtered.push(row)
      }
    }

    return filtered.map(mapEntity)
  }

  async function getEntityForWorld(worldName: string): Promise<Entity | undefined> {
    if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
      logger.warn(`Attempt to access entity for world ${worldName} which is banned.`)
      return undefined
    }

    const result = await database.query<Pick<SceneRecord, 'entity_id' | 'entity'>>(
      SQL`SELECT entity_id, entity FROM scenes WHERE world_name = ${worldName.toLowerCase()} ORDER BY world_name`
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

  async function undeploy(worldName: string): Promise<void> {
    await database.query(SQL`DELETE FROM scenes WHERE world_name = ${worldName.toLowerCase()}`)
  }

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    const result = await database.query<ContributorDomain>(SQL`
      SELECT DISTINCT name, array_agg(permission) as user_permissions, size, owner
      FROM (
        SELECT *
        FROM worlds w, json_each_text(w.permissions) AS perm(permission, permissionValue)
        WHERE permission = ANY(ARRAY['deployment', 'streaming'])
      ) AS wp
      WHERE EXISTS (
        SELECT 1 FROM json_array_elements_text(wp.permissionValue::json -> 'wallets') as wallet WHERE LOWER(wallet) = LOWER(${address})
      )
      GROUP BY name, size, owner
    `)

    return {
      domains: result.rows,
      count: result.rowCount
    }
  }

  async function getDeployedScenesForWorld(worldName: string): Promise<SceneRecord[]> {
    const result = await database.query<SceneRecord>(
      SQL`SELECT * FROM scenes WHERE world_name = ${worldName.toLowerCase()} ORDER BY created_at DESC`
    )

    return result.rows
  }

  async function findCollisions(entity: Entity, previousScenes: SceneRecord[]): Promise<SceneRecord[]> {
    const newParcels = new Set(entity.pointers)
    return previousScenes.filter(
      (row) =>
        newParcels.has(row.entity.metadata.scene.base) ||
        row.entity.metadata.scene.parcels.some((parcel: string) => newParcels.has(parcel))
    )
  }

  return {
    getRawSceneRecords,
    getContributableDomains,
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
