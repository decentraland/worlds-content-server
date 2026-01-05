import {
  AppComponents,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  WorldMetadata,
  WorldRecord,
  WorldScene,
  WorldSettings,
  ContributorDomain
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { extractWorldRuntimeMetadata, buildWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../logic/permissions-checker'

export async function createWorldsManagerComponent({
  logs,
  database,
  nameDenyListChecker,
  storage
}: Pick<AppComponents, 'logs' | 'database' | 'nameDenyListChecker' | 'storage'>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')

  async function getRawWorldRecords(): Promise<WorldRecord[]> {
    const result = await database.query<WorldRecord>(
      SQL`SELECT worlds.*, blocked.created_at AS blocked_since
              FROM worlds
              LEFT JOIN blocked ON worlds.owner = blocked.wallet`
    )

    const filtered: WorldRecord[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.name)) {
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

    const result = await database.query<WorldRecord>(
      SQL`SELECT worlds.*, blocked.created_at AS blocked_since
              FROM worlds
              LEFT JOIN blocked ON worlds.owner = blocked.wallet
              WHERE worlds.name = ${worldName.toLowerCase()}`
    )

    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]

    // Get all scenes for this world
    const scenes = await getWorldScenes(worldName)

    // Build runtime metadata from world settings or scenes
    const runtimeMetadata = buildWorldRuntimeMetadata(worldName, row.world_settings, scenes)

    const metadata: WorldMetadata = {
      entityId: row.entity_id, // Deprecated, kept for backward compatibility
      permissions: row.permissions,
      runtimeMetadata,
      scenes,
      owner: row.owner,
      blockedSince: row.blocked_since ? new Date(row.blocked_since) : undefined
    }

    return metadata
  }

  async function deployScene(worldName: string, scene: Entity, owner: EthAddress, parcels: string[]): Promise<void> {
    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const fileInfos = await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size = scene.content?.reduce((acc, c) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

    // Use a transaction to ensure atomicity
    await database.query('BEGIN')

    try {
      // Ensure world record exists
      const worldExists = await database.query(SQL`SELECT name FROM worlds WHERE name = ${worldName.toLowerCase()}`)

      if (worldExists.rowCount === 0) {
        await database.query(SQL`
          INSERT INTO worlds (name, owner, permissions, created_at, updated_at)
          VALUES (
            ${worldName.toLowerCase()}, 
            ${owner?.toLowerCase()}, 
            ${JSON.stringify(defaultPermissions())}::json,
            ${new Date()}, 
            ${new Date()}
          )
        `)
      } else {
        // Update owner if changed
        await database.query(SQL`
          UPDATE worlds
          SET owner = ${owner?.toLowerCase()},
              updated_at = ${new Date()}
          WHERE name = ${worldName.toLowerCase()}
        `)
      }

      // Delete any existing scenes on these parcels
      await database.query(SQL`
        DELETE FROM world_scenes 
        WHERE world_name = ${worldName.toLowerCase()} 
        AND parcels && ${parcels}::text[]
      `)

      // Insert new scene
      await database.query(SQL`
        INSERT INTO world_scenes (
          world_name, entity_id, deployer, deployment_auth_chain, 
          entity, parcels, size, created_at, updated_at
        ) VALUES (
          ${worldName.toLowerCase()}, 
          ${scene.id},
          ${deployer}, 
          ${deploymentAuthChainString}::json,
          ${scene}::json,
          ${parcels}::text[],
          ${size},
          ${new Date()}, 
          ${new Date()}
        )
      `)

      // Keep backward compatibility: update worlds table with latest deployment
      await database.query(SQL`
        UPDATE worlds
        SET entity_id = ${scene.id}, 
            deployer = ${deployer},
            entity = ${scene}::json,
            size = ${size},
            deployment_auth_chain = ${deploymentAuthChainString}::json,
            updated_at = ${new Date()}
        WHERE name = ${worldName.toLowerCase()}
      `)

      await database.query('COMMIT')
    } catch (error) {
      await database.query('ROLLBACK')
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
    const result = await database.query<{ name: string }>('SELECT name FROM worlds WHERE entity_id IS NOT NULL')
    return result.rows.reduce(
      (acc, row) => {
        if (row.name.endsWith('.dcl.eth')) {
          acc.dcl++
        } else {
          acc.ens++
        }
        return acc
      },
      { ens: 0, dcl: 0 }
    )
  }

  const mapEntity = (row: Pick<WorldRecord, 'entity_id' | 'entity' | 'owner'>) => ({
    ...row.entity,
    id: row.entity_id,
    metadata: {
      ...row.entity.metadata,
      owner: row.owner
    }
  })

  async function getDeployedWorldEntities(): Promise<Entity[]> {
    const result = await database.query<Pick<WorldRecord, 'name' | 'entity_id' | 'entity' | 'owner'>>(
      'SELECT name, entity_id, entity, owner FROM worlds WHERE entity_id IS NOT NULL ORDER BY name'
    )

    const filtered: Pick<WorldRecord, 'name' | 'entity_id' | 'entity' | 'owner'>[] = []
    for (const row of result.rows) {
      if (await nameDenyListChecker.checkNameDenyList(row.name)) {
        filtered.push(row)
      }
    }

    return filtered.map(mapEntity)
  }

  async function getEntityForWorlds(worldNames: string[]): Promise<Entity[]> {
    if (worldNames.length === 0) {
      return []
    }

    const allowedNames: string[] = []
    for (const worldName of worldNames) {
      if (await nameDenyListChecker.checkNameDenyList(worldName)) {
        allowedNames.push(worldName)
      }
    }

    if (allowedNames.length === 0) {
      return []
    }

    const result = await database.query<Pick<WorldRecord, 'entity_id' | 'entity' | 'owner'>>(
      SQL`
        SELECT entity_id, entity, owner 
        FROM worlds 
        WHERE name = ANY(${allowedNames}) 
          AND entity_id IS NOT NULL 
          ORDER BY name
      `
    )

    return result.rows.map(mapEntity)
  }

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
  }

  async function undeploy(worldName: string): Promise<void> {
    const sql = SQL`
             UPDATE worlds
             SET entity_id = null, 
                 owner = null,
                 deployer = null,
                 entity = null,
                 size = null,
                 deployment_auth_chain = null,
                 updated_at = ${new Date()}
              WHERE name = ${worldName.toLowerCase()}
    `
    await database.query(sql)
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

  async function getWorldScenes(worldName: string): Promise<WorldScene[]> {
    const result = await database.query<{
      id: number
      world_name: string
      entity_id: string
      deployer: string
      deployment_auth_chain: any
      entity: any
      parcels: string[]
      size: string
      created_at: Date
      updated_at: Date
    }>(SQL`
      SELECT * FROM world_scenes 
      WHERE world_name = ${worldName.toLowerCase()}
      ORDER BY created_at
    `)

    return result.rows.map((row) => ({
      id: row.entity_id,
      worldName: row.world_name,
      deployer: row.deployer,
      deploymentAuthChain: row.deployment_auth_chain,
      entity: row.entity,
      parcels: row.parcels,
      size: BigInt(row.size),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async function undeployScene(worldName: string, parcels: string[]): Promise<void> {
    await database.query(SQL`
      DELETE FROM world_scenes 
      WHERE world_name = ${worldName.toLowerCase()} 
      AND parcels && ${parcels}::text[]
    `)
  }

  async function getOccupiedParcels(worldName: string): Promise<string[]> {
    const result = await database.query<{ parcel: string }>(SQL`
      SELECT DISTINCT unnest(parcels) as parcel 
      FROM world_scenes 
      WHERE world_name = ${worldName.toLowerCase()}
    `)

    return result.rows.map((row) => row.parcel)
  }

  async function checkParcelsAvailable(
    worldName: string,
    parcels: string[]
  ): Promise<{ available: boolean; conflicts: string[] }> {
    if (parcels.length === 0) {
      return { available: true, conflicts: [] }
    }

    const result = await database.query<{ occupied: string[] }>(SQL`
      SELECT ARRAY(
        SELECT DISTINCT p 
        FROM world_scenes, unnest(parcels) as p
        WHERE world_name = ${worldName.toLowerCase()}
        AND p = ANY(${parcels}::text[])
      ) as occupied
    `)

    const conflicts = result.rows[0]?.occupied || []
    return {
      available: conflicts.length === 0,
      conflicts
    }
  }

  async function updateWorldSettings(worldName: string, settings: WorldSettings): Promise<void> {
    await database.query(SQL`
      UPDATE worlds 
      SET world_settings = ${JSON.stringify(settings)}::json,
          description = ${settings.description || null},
          thumbnail_hash = ${settings.thumbnailFile || null},
          updated_at = ${new Date()}
      WHERE name = ${worldName.toLowerCase()}
    `)
  }

  async function getWorldSettings(worldName: string): Promise<WorldSettings | undefined> {
    const result = await database.query<{ world_settings: WorldSettings }>(SQL`
      SELECT world_settings FROM worlds WHERE name = ${worldName.toLowerCase()}
    `)

    return result.rows[0]?.world_settings || undefined
  }

  async function getTotalWorldSize(worldName: string): Promise<bigint> {
    const result = await database.query<{ total_size: string }>(SQL`
      SELECT COALESCE(SUM(size), 0) as total_size 
      FROM world_scenes 
      WHERE world_name = ${worldName.toLowerCase()}
    `)

    return BigInt(result.rows[0]?.total_size || 0)
  }

  return {
    getRawWorldRecords,
    getDeployedWorldCount,
    getDeployedWorldEntities,
    getMetadataForWorld,
    getEntityForWorlds,
    deployScene,
    undeployScene,
    storePermissions,
    permissionCheckerForWorld,
    undeploy,
    getContributableDomains,
    getWorldScenes,
    getOccupiedParcels,
    checkParcelsAvailable,
    updateWorldSettings,
    getWorldSettings,
    getTotalWorldSize
  }
}
