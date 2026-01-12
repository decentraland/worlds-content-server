import {
  AppComponents,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  WorldMetadata,
  WorldRecord,
  WorldScene,
  WorldSettings,
  ContributorDomain,
  GetWorldScenesFilters,
  GetWorldScenesResult
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress, PaginatedParameters } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { buildWorldRuntimeMetadata, extractSpawnCoordinates } from '../logic/world-runtime-metadata-utils'
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

    // Get the scene at spawn point (spawn_coordinates is always set if there are scenes)
    let scenes: WorldScene[] = []
    if (row.spawn_coordinates) {
      const { scenes: spawnScenes } = await getWorldScenes(
        { worldName, coordinates: [row.spawn_coordinates] },
        { limit: 1 }
      )
      scenes = spawnScenes
    }

    // Build runtime metadata from scenes
    const runtimeMetadata = buildWorldRuntimeMetadata(worldName, scenes)

    const metadata: WorldMetadata = {
      permissions: row.permissions,
      spawnCoordinates: row.spawn_coordinates,
      runtimeMetadata,
      scenes,
      owner: row.owner,
      blockedSince: row.blocked_since ? new Date(row.blocked_since) : undefined
    }

    return metadata
  }

  async function deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void> {
    const parcels: string[] = scene.metadata?.scene?.parcels || []

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
        const spawnCoordinates = extractSpawnCoordinates(scene)
        await database.query(SQL`
          INSERT INTO worlds (name, owner, permissions, spawn_coordinates, created_at, updated_at)
          VALUES (
            ${worldName.toLowerCase()}, 
            ${owner?.toLowerCase()}, 
            ${JSON.stringify(defaultPermissions())}::json,
            ${spawnCoordinates},
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
          ${scene}::jsonb,
          ${parcels}::text[],
          ${size},
          ${new Date()}, 
          ${new Date()}
        )
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
    // Count worlds that have at least one scene deployed
    const result = await database.query<{ name: string }>(`
      SELECT w.name 
      FROM worlds w 
      WHERE EXISTS (SELECT 1 FROM world_scenes ws WHERE ws.world_name = w.name)
    `)
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

  async function getEntityForWorlds(worldNames: string[]): Promise<Entity[]> {
    if (worldNames.length === 0) {
      return []
    }

    const allowedNames: string[] = []
    for (const worldName of worldNames) {
      if (await nameDenyListChecker.checkNameDenyList(worldName)) {
        allowedNames.push(worldName.toLowerCase())
      }
    }

    if (allowedNames.length === 0) {
      return []
    }

    // Get one entity per world: the scene at spawn_coordinates (spawn_coordinates is always set if there are scenes)
    const result = await database.query<{
      world_name: string
      entity_id: string
      entity: any
      owner: string
    }>(
      SQL`
        SELECT ws.world_name, ws.entity_id, ws.entity, w.owner
        FROM worlds w
        INNER JOIN world_scenes ws ON ws.world_name = w.name
        WHERE w.name = ANY(${allowedNames})
          AND w.spawn_coordinates IS NOT NULL
          AND ws.parcels @> ARRAY[w.spawn_coordinates]::text[]
      `
    )

    return result.rows.map((row) => ({
      ...row.entity,
      id: row.entity_id,
      metadata: {
        ...row.entity.metadata,
        owner: row.owner
      }
    }))
  }

  async function permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker> {
    const metadata = await getMetadataForWorld(worldName)
    return createPermissionChecker(metadata?.permissions || defaultPermissions())
  }

  async function undeployWorld(worldName: string): Promise<void> {
    const normalizedWorldName = worldName.toLowerCase()

    await database.query('BEGIN')

    try {
      // Delete all scenes for the world
      await database.query(SQL`DELETE FROM world_scenes WHERE world_name = ${normalizedWorldName}`)

      // Set spawn_coordinates to null since there are no more scenes
      await database.query(SQL`UPDATE worlds SET spawn_coordinates = NULL WHERE name = ${normalizedWorldName}`)

      await database.query('COMMIT')
    } catch (error) {
      await database.query('ROLLBACK')
      throw error
    }
  }

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    const result = await database.query<ContributorDomain>(SQL`
      SELECT 
        wp.name,
        array_agg(DISTINCT wp.permission) as user_permissions,
        COALESCE(sizes.total_size, 0)::text as size,
        wp.owner
      FROM (
        SELECT w.name, w.owner, perm.permission
        FROM worlds w, json_each_text(w.permissions) AS perm(permission, permissionValue)
        WHERE perm.permission = ANY(ARRAY['deployment', 'streaming'])
          AND EXISTS (
            SELECT 1 FROM json_array_elements_text(perm.permissionValue::json -> 'wallets') as wallet 
            WHERE LOWER(wallet) = LOWER(${address})
          )
      ) AS wp
      LEFT JOIN (
        SELECT world_name, SUM(size) as total_size
        FROM world_scenes
        GROUP BY world_name
      ) AS sizes ON wp.name = sizes.world_name
      GROUP BY wp.name, wp.owner, sizes.total_size
    `)

    return {
      domains: result.rows,
      count: result.rowCount ?? 0
    }
  }

  async function getWorldScenes(
    filters?: GetWorldScenesFilters,
    options?: PaginatedParameters
  ): Promise<GetWorldScenesResult> {
    // Build base queries
    const countQuery = SQL`SELECT COUNT(*) as total FROM world_scenes WHERE 1=1`
    const mainQuery = SQL`SELECT * FROM world_scenes WHERE 1=1`

    // Apply worldName filter
    if (filters?.worldName) {
      countQuery.append(SQL` AND world_name = ${filters.worldName.toLowerCase()}`)
      mainQuery.append(SQL` AND world_name = ${filters.worldName.toLowerCase()}`)
    }

    // Apply coordinates filter (scenes that contain any of the specified coordinates)
    if (filters?.coordinates && filters.coordinates.length > 0) {
      countQuery.append(SQL` AND parcels && ${filters.coordinates}::text[]`)
      mainQuery.append(SQL` AND parcels && ${filters.coordinates}::text[]`)
    }

    // Add ordering
    mainQuery.append(SQL` ORDER BY created_at`)

    // Apply pagination
    if (options?.limit !== undefined) {
      mainQuery.append(SQL` LIMIT ${options.limit}`)
    }

    if (options?.offset !== undefined) {
      mainQuery.append(SQL` OFFSET ${options.offset}`)
    }

    // Execute both queries concurrently
    const [countResult, result] = await Promise.all([
      database.query<{ total: string }>(countQuery),
      database.query<{
        world_name: string
        entity_id: string
        deployer: string
        deployment_auth_chain: any
        entity: any
        parcels: string[]
        size: string
        created_at: Date
        updated_at: Date
      }>(mainQuery)
    ])

    const total = parseInt(countResult.rows[0]?.total || '0', 10)

    const scenes = result.rows.map((row) => ({
      worldName: row.world_name,
      deployer: row.deployer,
      entityId: row.entity_id,
      deploymentAuthChain: row.deployment_auth_chain,
      entity: row.entity,
      parcels: row.parcels,
      size: BigInt(row.size),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))

    return { scenes, total }
  }

  async function undeployScene(worldName: string, parcels: string[]): Promise<void> {
    const normalizedWorldName = worldName.toLowerCase()

    await database.query('BEGIN')

    try {
      // Get current spawn_coordinates before deletion
      const worldResult = await database.query<{ spawn_coordinates: string | null }>(
        SQL`SELECT spawn_coordinates FROM worlds WHERE name = ${normalizedWorldName}`
      )
      const currentSpawnCoordinates = worldResult.rows[0]?.spawn_coordinates

      // Delete the scene(s) matching the parcels
      await database.query(SQL`
        DELETE FROM world_scenes 
        WHERE world_name = ${normalizedWorldName} 
        AND parcels && ${parcels}::text[]
      `)

      // Check if we need to update spawn_coordinates
      const deletedSpawnCoordinatesScene = currentSpawnCoordinates && parcels.includes(currentSpawnCoordinates)

      if (deletedSpawnCoordinatesScene) {
        // Find another scene to set as spawn_coordinates, or null if none remain
        const remainingScene = await database.query<{ parcels: string[] }>(SQL`
          SELECT parcels FROM world_scenes 
          WHERE world_name = ${normalizedWorldName} 
          ORDER BY created_at 
          LIMIT 1
        `)

        const newSpawnCoordinates = remainingScene.rows[0]?.parcels[0] || null

        await database.query(SQL`
          UPDATE worlds SET spawn_coordinates = ${newSpawnCoordinates} WHERE name = ${normalizedWorldName}
        `)
      }

      await database.query('COMMIT')
    } catch (error) {
      await database.query('ROLLBACK')
      throw error
    }
  }

  async function updateWorldSettings(worldName: string, settings: WorldSettings): Promise<void> {
    await database.query(SQL`
      UPDATE worlds 
      SET spawn_coordinates = ${settings.spawnCoordinates || null},
          updated_at = ${new Date()}
      WHERE name = ${worldName.toLowerCase()}
    `)
  }

  async function getWorldSettings(worldName: string): Promise<WorldSettings | undefined> {
    const result = await database.query<{ spawn_coordinates: string | null }>(SQL`
      SELECT spawn_coordinates FROM worlds WHERE name = ${worldName.toLowerCase()}
    `)

    if (result.rowCount === 0) {
      return undefined
    }

    return {
      spawnCoordinates: result.rows[0].spawn_coordinates || undefined
    }
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
    getMetadataForWorld,
    getEntityForWorlds,
    deployScene,
    undeployScene,
    storePermissions,
    permissionCheckerForWorld,
    undeployWorld,
    getContributableDomains,
    getWorldScenes,
    updateWorldSettings,
    getWorldSettings,
    getTotalWorldSize
  }
}
