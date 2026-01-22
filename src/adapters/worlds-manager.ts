import {
  AppComponents,
  IPermissionChecker,
  IWorldsManager,
  Permissions,
  WorldMetadata,
  WorldRecord,
  WorldSettings,
  ContributorDomain,
  GetWorldScenesFilters,
  GetWorldScenesOptions,
  GetWorldScenesResult,
  WorldBoundingRectangle,
  SceneOrderBy,
  OrderDirection
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { PoolClient } from 'pg'
import { buildWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { createPermissionChecker, defaultPermissions } from '../logic/permissions-checker'

type BoundingRow = { min_x: number; max_x: number; min_y: number; max_y: number }

export async function createWorldsManagerComponent({
  coordinates,
  logs,
  database,
  nameDenyListChecker,
  storage
}: Pick<
  AppComponents,
  'coordinates' | 'logs' | 'database' | 'nameDenyListChecker' | 'storage'
>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')
  const { extractSpawnCoordinates, parseCoordinate, isCoordinateWithinRectangle, getRectangleCenter } = coordinates

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

    // Get the last deployed scene (most recently deployed)
    const { scenes } = await getWorldScenes(
      { worldName },
      { limit: 1, orderBy: SceneOrderBy.CreatedAt, orderDirection: OrderDirection.Desc }
    )

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

  /**
   * Deploys a scene to a world
   *
   * This method handles the complete scene deployment workflow within a database transaction:
   * 1. Extracts parcels and deployment auth chain from the scene
   * 2. Calculates total scene size from content files
   * 3. Creates or updates the world record with owner and spawn coordinates
   * 4. Removes any existing scenes that overlap with the new scene's parcels
   * 5. Inserts the new scene into the world_scenes table
   *
   * The transaction ensures atomicity - if any step fails, all changes are rolled back.
   *
   * @param worldName - The name of the world to deploy the scene to
   * @param scene - The scene entity containing metadata, content, and parcel information
   * @param owner - The Ethereum address of the world owner
   * @throws {Error} If the deployment auth chain cannot be retrieved or parsed
   * @throws {Error} If any database operation fails (triggers rollback)
   */
  async function deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void> {
    const parcels: string[] = scene.metadata?.scene?.parcels || []

    const content = await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = content ? (await streamToBuffer(await content!.asStream())).toString() : '{}'
    const deploymentAuthChain = JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const fileInfos = await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size = scene.content?.reduce((acc, c) => acc + (fileInfos.get(c.hash)?.size || 0), 0) || 0

    // Use a transaction to ensure atomicity
    const client = await database.getPool().connect()
    const spawnCoordinates = extractSpawnCoordinates(scene)

    try {
      await client.query('BEGIN')

      // Ensure world record exists, update if it does
      await client.query(SQL`
        INSERT INTO worlds (name, owner, permissions, spawn_coordinates, created_at, updated_at)
        VALUES (
          ${worldName.toLowerCase()}, 
          ${owner?.toLowerCase()}, 
          ${JSON.stringify(defaultPermissions())}::json,
          ${spawnCoordinates},
          ${new Date()}, 
          ${new Date()}
        )
        ON CONFLICT (name) DO UPDATE SET
          owner = ${owner?.toLowerCase()},
          spawn_coordinates = COALESCE(worlds.spawn_coordinates, EXCLUDED.spawn_coordinates),
          updated_at = ${new Date()}
      `)

      // Delete any existing scenes on these parcels
      await client.query(SQL`
        DELETE FROM world_scenes 
        WHERE world_name = ${worldName.toLowerCase()} 
        AND parcels && ${parcels}::text[]
      `)

      // Insert new scene
      await client.query(SQL`
        INSERT INTO world_scenes (
          world_name, entity_id, deployer, deployment_auth_chain, 
          entity, parcels, size, created_at
        ) VALUES (
          ${worldName.toLowerCase()}, 
          ${scene.id},
          ${deployer}, 
          ${deploymentAuthChainString}::json,
          ${scene}::jsonb,
          ${parcels}::text[],
          ${size},
          ${new Date()}
        )
      `)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
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

    // Get one entity per world: the last deployed scene (most recently created)
    const result = await database.query<{
      world_name: string
      entity_id: string
      entity: any
      owner: string
    }>(
      SQL`
        SELECT DISTINCT ON (ws.world_name) ws.world_name, ws.entity_id, ws.entity, w.owner
        FROM worlds w
        INNER JOIN world_scenes ws ON ws.world_name = w.name
        WHERE w.name = ANY(${allowedNames})
        ORDER BY ws.world_name, ws.created_at DESC
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

    const client = await database.getPool().connect()

    try {
      await client.query('BEGIN')

      // Delete all scenes for the world
      await client.query(SQL`DELETE FROM world_scenes WHERE world_name = ${normalizedWorldName}`)

      // Set spawn_coordinates to null since there are no more scenes
      await client.query(SQL`UPDATE worlds SET spawn_coordinates = NULL WHERE name = ${normalizedWorldName}`)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
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
    options?: GetWorldScenesOptions
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

    // Add ordering (default: created_at ASC)
    const orderBy = options?.orderBy ?? SceneOrderBy.CreatedAt
    const orderDirection = options?.orderDirection ?? OrderDirection.Asc
    // Using safe string interpolation since orderBy and orderDirection are enum values
    mainQuery.append(` ORDER BY ${orderBy} ${orderDirection.toUpperCase()}`)

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
      createdAt: row.created_at
    }))

    return { scenes, total }
  }

  async function undeployScene(worldName: string, parcels: string[]): Promise<void> {
    const normalizedWorldName = worldName.toLowerCase()

    const client = await database.getPool().connect()

    try {
      await client.query('BEGIN')

      // Get current spawn_coordinates before deletion
      const worldResult = await client.query<{ spawn_coordinates: string | null }>(
        SQL`SELECT spawn_coordinates FROM worlds WHERE name = ${normalizedWorldName}`
      )
      const currentSpawnCoordinates = worldResult.rows[0]?.spawn_coordinates

      // Delete the scene(s) matching the parcels
      await client.query(SQL`
        DELETE FROM world_scenes 
        WHERE world_name = ${normalizedWorldName} 
        AND parcels && ${parcels}::text[]
      `)

      // Calculate new bounding rectangle (after deletion) using the shared function
      const boundingRectangle = await getWorldBoundingRectangle(normalizedWorldName, client)

      // Check if we need to update spawn_coordinates
      let newSpawnCoordinates: string | null = currentSpawnCoordinates

      if (!boundingRectangle) {
        // No scenes remain, set spawn_coordinates to null
        newSpawnCoordinates = null
      } else if (currentSpawnCoordinates) {
        // Check if current spawn coordinates are still within the bounding rectangle
        const spawnCoord = parseCoordinate(currentSpawnCoordinates)
        const isWithinBounds = isCoordinateWithinRectangle(spawnCoord, boundingRectangle)

        if (!isWithinBounds) {
          // Spawn coordinates are outside the new bounding rectangle, update to center of rectangle
          const center = getRectangleCenter(boundingRectangle)
          newSpawnCoordinates = `${center.x},${center.y}`
        }
      }

      if (newSpawnCoordinates !== currentSpawnCoordinates) {
        await client.query(SQL`
          UPDATE worlds SET spawn_coordinates = ${newSpawnCoordinates} WHERE name = ${normalizedWorldName}
        `)
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
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

  /**
   * Gets the bounding rectangle for all deployed scenes in a world
   * Computed directly in SQL to avoid fetching all parcels
   *
   * @param worldName - The name of the world
   * @param client - Optional database client to use (for transactions)
   * @returns The bounding rectangle, or undefined if no parcels exist
   */
  async function getWorldBoundingRectangle(
    worldName: string,
    client?: PoolClient
  ): Promise<WorldBoundingRectangle | undefined> {
    const query = SQL`
      SELECT 
        MIN(SPLIT_PART(parcel, ',', 1)::integer) as min_x,
        MAX(SPLIT_PART(parcel, ',', 1)::integer) as max_x,
        MIN(SPLIT_PART(parcel, ',', 2)::integer) as min_y,
        MAX(SPLIT_PART(parcel, ',', 2)::integer) as max_y
      FROM world_scenes, UNNEST(parcels) as parcel
      WHERE world_name = ${worldName.toLowerCase()}
    `

    const { rows } = client ? await client.query<BoundingRow>(query) : await database.query<BoundingRow>(query)

    const row = rows[0]
    if (row.min_x === null || row.max_x === null || row.min_y === null || row.max_y === null) {
      return undefined
    }

    return {
      min: { x: row.min_x, y: row.min_y },
      max: { x: row.max_x, y: row.max_y }
    }
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
    getTotalWorldSize,
    getWorldBoundingRectangle
  }
}
