import {
  AccessModificationResult,
  AppComponents,
  IWorldsManager,
  WorldMetadata,
  WorldRecord,
  WorldSettings,
  ContributorDomain,
  GetWorldScenesFilters,
  GetWorldScenesOptions,
  GetWorldScenesResult,
  WorldBoundingRectangle,
  SceneOrderBy,
  OrderDirection,
  UpdateWorldSettingsResult,
  SpawnCoordinatesOutOfBoundsError,
  NoDeployedScenesError,
  GetWorldsFilters,
  GetWorldsOptions,
  GetWorldsResult,
  WorldInfo,
  WorldsOrderBy,
  GetRawWorldRecordsFilters,
  GetRawWorldRecordsOptions,
  GetRawWorldRecordsResult,
  GetOccupiedParcelsOptions,
  GetOccupiedParcelsResult,
  SceneDeploymentStatus,
  SceneDeploymentData,
  SceneReplacementAuthorization,
  SceneReplacementConflictError,
  SceneUndeploymentResult
} from '../types'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { Entity, EthAddress } from '@dcl/schemas'
import SQL, { type SQLStatement } from 'sql-template-strings'
import { buildWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { AccessSetting, defaultAccess } from '../logic/access'
import { raceWithSignal } from '../logic/concurrency'

type BoundingRow = { min_x: number; max_x: number; min_y: number; max_y: number }

/**
 * A change to a world's stored settings.
 *
 * An absent key means "leave this alone"; a present key is written, including when it is null, which
 * clears the column. That distinction is what lets the deploy path preserve everything the scene does
 * not express while the settings endpoint can clear a value on request.
 */
type WorldSettingsPatch = {
  title?: string | null
  description?: string | null
  contentRating?: string | null
  skyboxTime?: number | null
  categories?: string[] | null
  singlePlayer?: boolean | null
  showInPlaces?: boolean | null
  thumbnailHash?: string | null
}

/**
 * Includes a settings field in a patch only when the source expressed it, so "not expressed" stays
 * distinct from "expressed as null", which clears the column.
 */
function definedSetting<K extends keyof WorldSettingsPatch>(
  key: K,
  value: WorldSettingsPatch[K] | null
): Partial<WorldSettingsPatch> {
  return value === null ? {} : ({ [key]: value } as Partial<WorldSettingsPatch>)
}

/** A column this patch writes, as fragments so each use gets its own bound parameters. */
type PatchedSettingsColumn = {
  name: () => SQLStatement
  value: () => SQLStatement
}

function patchedSettingsColumns(patch: WorldSettingsPatch): PatchedSettingsColumn[] {
  const columns: PatchedSettingsColumn[] = []

  if (patch.title !== undefined) {
    columns.push({ name: () => SQL`title`, value: () => SQL`${patch.title}` })
  }
  if (patch.description !== undefined) {
    columns.push({ name: () => SQL`description`, value: () => SQL`${patch.description}` })
  }
  if (patch.contentRating !== undefined) {
    columns.push({ name: () => SQL`content_rating`, value: () => SQL`${patch.contentRating}` })
  }
  if (patch.skyboxTime !== undefined) {
    columns.push({ name: () => SQL`skybox_time`, value: () => SQL`${patch.skyboxTime}` })
  }
  if (patch.categories !== undefined) {
    columns.push({ name: () => SQL`categories`, value: () => SQL`${patch.categories}::text[]` })
  }
  if (patch.singlePlayer !== undefined) {
    columns.push({ name: () => SQL`single_player`, value: () => SQL`${patch.singlePlayer}` })
  }
  if (patch.showInPlaces !== undefined) {
    columns.push({ name: () => SQL`show_in_places`, value: () => SQL`${patch.showInPlaces}` })
  }
  if (patch.thumbnailHash !== undefined) {
    columns.push({ name: () => SQL`thumbnail_hash`, value: () => SQL`${patch.thumbnailHash}` })
  }

  return columns
}

/**
 * Builds the SET list for a settings change, always including the version bump so no write path can
 * forget it. `worlds.settings_version` reads the row's current value in both a plain UPDATE and an
 * ON CONFLICT DO UPDATE.
 *
 * @param patch - The settings to write
 * @param updatedAt - Timestamp recorded on the row
 * @returns The assignments, or null when the patch writes nothing
 */
function buildSettingsAssignments(patch: WorldSettingsPatch, updatedAt: Date): SQLStatement | null {
  const columns = patchedSettingsColumns(patch)
  if (columns.length === 0) {
    return null
  }

  const statement = SQL``
  for (const column of columns) {
    statement
      .append(column.name())
      .append(SQL` = `)
      .append(column.value())
      .append(SQL`, `)
  }
  return statement.append(SQL`settings_version = worlds.settings_version + 1, updated_at = ${updatedAt}`)
}

/**
 * Builds a predicate that holds only when the patch would actually change the row, so an unchanged
 * republish neither bumps the version nor makes callers announce a change that did not happen.
 *
 * @param patch - The settings to write
 * @returns The predicate, or null when the patch writes nothing
 */
function buildSettingsChangedPredicate(patch: WorldSettingsPatch): SQLStatement | null {
  const columns = patchedSettingsColumns(patch)
  if (columns.length === 0) {
    return null
  }

  const names = SQL``
  const incoming = SQL``
  columns.forEach((column, index) => {
    if (index > 0) {
      names.append(SQL`, `)
      incoming.append(SQL`, `)
    }
    names.append(column.name())
    incoming.append(column.value())
  })

  return SQL`(`
    .append(names)
    .append(SQL`) IS DISTINCT FROM (`)
    .append(incoming)
    .append(SQL`)`)
}

export async function createWorldsManagerComponent({
  settingsPolicy,
  coordinates,
  logs,
  database,
  nameDenyListChecker,
  search,
  storage,
  thumbnails
}: Pick<
  AppComponents,
  'settingsPolicy' | 'coordinates' | 'logs' | 'database' | 'nameDenyListChecker' | 'search' | 'storage' | 'thumbnails'
>): Promise<IWorldsManager> {
  const logger = logs.getLogger('worlds-manager')
  const {
    canonicalizeParcels,
    extractSpawnCoordinates,
    parseCoordinate,
    isCoordinateWithinRectangle,
    getRectangleCenter
  } = coordinates

  type DeploymentTransactionResult<T extends Record<string, unknown>> = { rows: T[] }
  type DeploymentTransactionQuery = <T extends Record<string, unknown> = Record<string, never>>(
    statement: SQLStatement
  ) => Promise<DeploymentTransactionResult<T>>
  type DeploymentTransactionClient = {
    query<T extends Record<string, unknown> = Record<string, never>>(
      statement: string | SQLStatement
    ): Promise<DeploymentTransactionResult<T>>
    release(error?: Error): void
  }

  /**
   * Runs deployment persistence on a dedicated connection which is destroyed on cancellation.
   * Closing the connection makes PostgreSQL roll back active transaction work. Cancellation is
   * disabled immediately before COMMIT, which is the deployment's explicit success boundary.
   */
  async function withDeploymentTransaction(
    signal: AbortSignal | undefined,
    operation: (query: DeploymentTransactionQuery) => Promise<void>
  ): Promise<void> {
    if (!signal) {
      await database.withAsyncContextTransaction(() =>
        operation(<T extends Record<string, unknown>>(statement: SQLStatement) => database.query<T>(statement))
      )
      return
    }

    signal.throwIfAborted()
    const acquireClient = database.getPool().connect() as Promise<DeploymentTransactionClient>
    let client: Awaited<typeof acquireClient>
    try {
      client = await raceWithSignal(acquireClient, signal)
    } catch (error) {
      // If cancellation wins while the pool is saturated, release the eventual acquisition instead
      // of leaking a checked-out connection after this request has already returned.
      void acquireClient.then(
        (acquiredClient) => acquiredClient.release(),
        () => undefined
      )
      throw error
    }

    let released = false
    let commitStarted = false
    const abort = (): void => {
      if (!released && !commitStarted) {
        released = true
        const reason = signal.reason instanceof Error ? signal.reason : new Error('Deployment persistence aborted.')
        client.release(reason)
      }
    }
    signal.addEventListener('abort', abort, { once: true })

    try {
      signal.throwIfAborted()
      await client.query('BEGIN')
      const query: DeploymentTransactionQuery = async <T extends Record<string, unknown>>(statement: SQLStatement) => {
        signal.throwIfAborted()
        const result = await client.query<T>(statement)
        signal.throwIfAborted()
        return result
      }
      await operation(query)
      signal.throwIfAborted()

      // Once COMMIT begins, cancellation can no longer reliably distinguish a committed transaction
      // from a rolled-back one. Treat this point as success and let post-commit work be best-effort.
      commitStarted = true
      signal.removeEventListener('abort', abort)
      await client.query('COMMIT')
    } catch (error) {
      if (!released) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          logger.error('Error rolling back cancelled deployment transaction', {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          })
        }
      }
      if (signal.aborted && !commitStarted) {
        throw signal.reason ?? error
      }
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      if (!released) {
        released = true
        client.release()
      }
    }
  }

  /**
   * Gets a paginated list of raw world records with optional filtering
   *
   * @param filters - Optional filters for worldName
   * @param options - Pagination options (limit, offset)
   * @returns Paginated list of world records with total count
   */
  /**
   * Gets a paginated list of raw world records with optional filtering
   *
   * @param filters - Optional filters for worldName
   * @param options - Pagination options (limit, offset)
   * @returns Paginated list of world records with total count
   */
  async function getRawWorldRecords(
    filters: GetRawWorldRecordsFilters = {},
    options: GetRawWorldRecordsOptions = {}
  ): Promise<GetRawWorldRecordsResult> {
    // Get banned names to exclude from query
    const bannedNames = await nameDenyListChecker.getBannedNames()

    // Build base count query
    const countQuery = SQL`
      SELECT COUNT(*) as total
      FROM worlds
      WHERE 1=1
    `

    // Build main query
    const mainQuery = SQL`
      SELECT worlds.*, blocked.created_at AS blocked_since
      FROM worlds
      LEFT JOIN blocked ON worlds.owner = blocked.wallet
      WHERE 1=1
    `

    // Exclude banned names from both queries
    if (bannedNames.length > 0) {
      const bannedFilter = SQL` AND worlds.name != ALL(${bannedNames})`
      countQuery.append(bannedFilter)
      mainQuery.append(bannedFilter)
    }

    // Apply worldName filter
    if (filters.worldName) {
      const worldNameFilter = SQL` AND worlds.name = ${filters.worldName.toLowerCase()}`
      countQuery.append(worldNameFilter)
      mainQuery.append(worldNameFilter)
    }

    // Add ordering
    mainQuery.append(` ORDER BY worlds.name ASC`)

    // Apply pagination
    if (options.limit !== undefined) {
      mainQuery.append(SQL` LIMIT ${options.limit}`)
    }

    if (options.offset !== undefined) {
      mainQuery.append(SQL` OFFSET ${options.offset}`)
    }

    // Execute both queries concurrently
    const [countResult, result] = await Promise.all([
      database.query<{ total: string }>(countQuery),
      database.query<WorldRecord>(mainQuery)
    ])

    const total = parseInt(countResult.rows[0]?.total || '0', 10)

    return {
      records: result.rows,
      total
    }
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

    // Override with world settings from DB
    if (row.skybox_time !== null) {
      runtimeMetadata.skyboxFixedTime = row.skybox_time
    }

    if (row.single_player) {
      runtimeMetadata.fixedAdapter = 'offline:offline'
    }

    const metadata: WorldMetadata = {
      access: row.access,
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
   * The transaction ensures atomicity - if any step fails, all changes are rolled back. When a
   * signal is provided, cancellation destroys the dedicated PostgreSQL connection and rolls the
   * transaction back until COMMIT begins. Starting COMMIT is the deployment's success boundary:
   * the deadline-based statement timeout is armed for every business statement and cleared right
   * before COMMIT, so PostgreSQL cannot cancel the commit itself after the boundary is crossed.
   *
   * @param worldName - The name of the world to deploy the scene to
   * @param scene - The scene entity containing metadata, content, and parcel information
   * @param owner - The Ethereum address of the world owner
   * @param replacementAuthorization - Explicit owner-wide or scene-identity-scoped replacement authority
   * @param deployment - Prevalidated deployment data, deadline, and optional cancellation signal
   * @throws {Error} If the deployment auth chain cannot be retrieved or parsed
   * @throws {Error} If any database operation fails (triggers rollback)
   */
  async function deployScene(
    worldName: string,
    scene: Entity,
    owner: EthAddress,
    replacementAuthorization: SceneReplacementAuthorization,
    deployment?: SceneDeploymentData
  ): Promise<{ metadataUpdated: boolean }> {
    // Canonicalize so the stored parcels, the overlap-based replacement here, the undeploy
    // authorization, and the size credit-back all compare parcels by value (e.g. "00,00" ==
    // "0,0"). Otherwise a non-canonical scene.parcels could dodge replacement / over-credit.
    const parcels: string[] = coordinates.canonicalizeParcels(scene.metadata?.scene?.parcels || [])
    if (!parcels.length) {
      throw new Error(`Attempt to deploy scene ${scene.id} to world ${worldName} with no parcels.`)
    }

    const content = deployment ? undefined : await storage.retrieve(`${scene.id}.auth`)
    const deploymentAuthChainString = deployment
      ? JSON.stringify(deployment.authChain)
      : content
        ? (await streamToBuffer(await content.asStream())).toString()
        : '{}'
    const deploymentAuthChain = deployment?.authChain ?? JSON.parse(deploymentAuthChainString)

    const deployer = deploymentAuthChain[0].payload.toLowerCase()

    const fileInfos = deployment ? undefined : await storage.fileInfoMultiple(scene.content?.map((c) => c.hash) || [])
    const size =
      deployment?.size ?? scene.content?.reduce((acc, c) => acc + (fileInfos?.get(c.hash)?.size || 0), 0) ?? 0

    const spawnCoordinates = extractSpawnCoordinates(scene)

    // Settings a scene does not express are left out of the patch entirely, so the update preserves
    // whatever the owner set through PUT /settings. Deriving a default here instead (e.g.
    // `fixedAdapter === 'offline:offline'`) would make "the scene said nothing" indistinguishable
    // from "the scene opted out" and silently revert owner settings. Values the policy rejects count
    // as not expressed rather than failing a deployment that is otherwise valid.
    const sceneMetadata = scene.metadata || {}
    const fixedAdapter = sceneMetadata.worldConfiguration?.fixedAdapter
    const optOut = sceneMetadata.worldConfiguration?.placesConfig?.optOut

    // The bytes are checked against the same formats the settings endpoint accepts, since a promoted
    // thumbnail is served verbatim to consumers.
    const navmapThumbnail = sceneMetadata.display?.navmapThumbnail
    const thumbnailContent = navmapThumbnail ? scene.content?.find((c) => c.file === navmapThumbnail) : null
    const thumbnailHash = thumbnailContent?.hash ? await thumbnails.resolveStorableHash(thumbnailContent.hash) : null

    const scenePatch: WorldSettingsPatch = {
      ...definedSetting('title', settingsPolicy.toStorableTitle(sceneMetadata.display?.title)),
      ...definedSetting('description', settingsPolicy.toStorableDescription(sceneMetadata.display?.description)),
      ...definedSetting(
        'contentRating',
        settingsPolicy.isValidContentRating(sceneMetadata?.rating) ? sceneMetadata.rating : null
      ),
      ...definedSetting(
        'skyboxTime',
        settingsPolicy.toStorableSkyboxTime(sceneMetadata.worldConfiguration?.skyboxConfig?.fixedTime)
      ),
      ...definedSetting('categories', settingsPolicy.toStorableCategories(sceneMetadata.tags)),
      ...definedSetting('singlePlayer', fixedAdapter === undefined ? null : fixedAdapter === 'offline:offline'),
      ...definedSetting('showInPlaces', optOut === undefined ? null : !optOut),
      ...definedSetting('thumbnailHash', thumbnailHash)
    }

    let metadataUpdated = false

    await withDeploymentTransaction(deployment?.signal, async (query) => {
      if (deployment?.deadlineAt !== undefined) {
        const remainingMs = Math.max(1, deployment.deadlineAt - Date.now())
        await query(SQL`SELECT set_config('statement_timeout', ${remainingMs.toString()}, true)`)
      }

      // Upsert the worlds row first to acquire the row lock. Metadata columns are written
      // on INSERT (first deploy) but left unchanged on UPDATE — the metadata update decision
      // requires a scene count check that must run AFTER the lock is acquired to avoid
      // snapshot staleness under READ COMMITTED.
      const upsertResult = await query<{ is_insert: boolean }>(SQL`
        INSERT INTO worlds (
          name, owner, access, spawn_coordinates,
          title, description, content_rating, skybox_time, categories,
          single_player, show_in_places, thumbnail_hash,
          created_at, updated_at
        )
        VALUES (
          ${worldName.toLowerCase()},
          ${owner.toLowerCase()},
          ${JSON.stringify(defaultAccess())}::jsonb,
          ${spawnCoordinates},
          ${scenePatch.title ?? null},
          ${scenePatch.description ?? null},
          ${scenePatch.contentRating ?? null},
          ${scenePatch.skyboxTime ?? null},
          ${scenePatch.categories ?? null}::text[],
          ${scenePatch.singlePlayer ?? null},
          ${scenePatch.showInPlaces ?? null},
          ${scenePatch.thumbnailHash ?? null},
          ${new Date()},
          ${new Date()}
        )
        ON CONFLICT (name) DO UPDATE SET
          owner = ${owner.toLowerCase()},
          spawn_coordinates = COALESCE(worlds.spawn_coordinates, EXCLUDED.spawn_coordinates),
          updated_at = ${new Date()}
        RETURNING (xmax = 0) AS is_insert
      `)

      // A fresh row already carries the scene's metadata from the INSERT above, so the refresh
      // statement below is skipped and the settings version starts at its default.
      const isInsert = upsertResult.rows[0]?.is_insert ?? false

      // After the row lock is held, check scene stats with a fresh snapshot (a single-statement
      // CTE would take its snapshot before the lock wait ends under READ COMMITTED).
      // Refresh metadata iff no non-overlapping scene survives this deploy: every currently
      // deployed scene is being replaced (or none exist), so the incoming scene ends up alone.
      if (!isInsert) {
        const statsResult = await query<{ should_update: boolean }>(SQL`
          SELECT COUNT(*) FILTER (WHERE NOT (parcels && ${parcels}::text[])) = 0 AS should_update
          FROM world_scenes
          WHERE world_name = ${worldName.toLowerCase()} AND status = 'DEPLOYED'
        `)
        const shouldUpdate = statsResult.rows[0]?.should_update ?? false

        const assignments = shouldUpdate ? buildSettingsAssignments(scenePatch, new Date()) : null
        const changed = shouldUpdate ? buildSettingsChangedPredicate(scenePatch) : null

        if (assignments && changed) {
          // The changed predicate keeps a republish of unchanged metadata from bumping the settings
          // version and emitting a settings-changed event with content consumers already have, so
          // metadataUpdated means "something actually changed", not "the statement ran".
          const refreshResult = await query<{ refreshed: boolean }>(
            SQL`UPDATE worlds SET `
              .append(assignments)
              .append(SQL` WHERE name = ${worldName.toLowerCase()} AND `)
              .append(changed)
              .append(SQL` RETURNING true AS refreshed`)
          )
          metadataUpdated = refreshResult.rows.length > 0
        }
      } else {
        metadataUpdated = true
      }

      if (replacementAuthorization.mode === 'unrestricted-owner') {
        // World-name owners may replace every overlapping scene.
        await query(SQL`
          UPDATE world_scenes SET status = 'UNDEPLOYED', updated_at = NOW()
          WHERE world_name = ${worldName.toLowerCase()}
          AND parcels && ${parcels}::text[]
          AND status = 'DEPLOYED'
        `)
      } else {
        // Parcel-scoped deployers may replace only the exact scenes whose full footprints were
        // authorized. The world upsert above locks this world's row, serializing deployments;
        // this final overlap check also protects against a stale authorization snapshot.
        await query(SQL`
          UPDATE world_scenes SET status = 'UNDEPLOYED', updated_at = NOW()
          WHERE world_name = ${worldName.toLowerCase()}
          AND parcels && ${parcels}::text[]
          AND status = 'DEPLOYED'
          AND entity_id = ANY(${replacementAuthorization.entityIds}::text[])
        `)

        const unexpectedOverlap = await query<{ entity_id: string }>(SQL`
          SELECT entity_id FROM world_scenes
          WHERE world_name = ${worldName.toLowerCase()}
          AND parcels && ${parcels}::text[]
          AND status = 'DEPLOYED'
          LIMIT 1
        `)
        if (unexpectedOverlap.rows.length > 0) {
          throw new SceneReplacementConflictError(worldName)
        }
      }

      // Insert new scene
      await query(SQL`
        INSERT INTO world_scenes (
          world_name, entity_id, deployer, deployment_auth_chain,
          entity, parcels, size, status, created_at, updated_at
        ) VALUES (
          ${worldName.toLowerCase()},
          ${scene.id},
          ${deployer},
          ${deploymentAuthChainString}::json,
          ${scene}::jsonb,
          ${parcels}::text[],
          ${size},
          'DEPLOYED',
          ${new Date()},
          ${new Date()}
        )
      `)

      // Update denormalized scene stats
      await query(buildRecalculateWorldSceneStatsQuery(worldName.toLowerCase()))

      if (deployment?.deadlineAt !== undefined) {
        // COMMIT is the deployment's success boundary: clear the transaction-local deadline so
        // PostgreSQL cannot cancel the COMMIT itself and report a possibly-committed deployment
        // as a pre-commit failure. Request cancellation still applies until COMMIT begins.
        await query(SQL`SELECT set_config('statement_timeout', ${'0'}, true)`)
      }
    })

    return { metadataUpdated }
  }

  async function storeAccess(worldName: string, access: AccessSetting): Promise<void> {
    // Bumps settings_version because mirrors read the access type through getWorldSettings and
    // order it with that version, so a visibility change has to move the version forward too.
    const sql = SQL`
              INSERT INTO worlds (name, access, created_at, updated_at)
              VALUES (${worldName.toLowerCase()}, ${JSON.stringify(access)}::jsonb,
                      ${new Date()}, ${new Date()})
              ON CONFLICT (name)
                  DO UPDATE SET access = ${JSON.stringify(access)}::jsonb,
                                settings_version = worlds.settings_version + 1,
                                updated_at = ${new Date()}
    `
    await database.query(sql)
  }

  async function modifyAccessAtomically(
    worldName: string,
    modifier: (currentAccess: AccessSetting) => AccessSetting
  ): Promise<AccessModificationResult> {
    return await database.withAsyncContextTransaction(async () => {
      const result = await database.query<{ access: AccessSetting }>(
        SQL`SELECT access FROM worlds WHERE name = ${worldName.toLowerCase()} FOR UPDATE`
      )
      const previousAccess = result.rows[0]?.access || defaultAccess()

      const updatedAccess = modifier(previousAccess)

      if (updatedAccess !== previousAccess) {
        await storeAccess(worldName, updatedAccess)
      }

      return { previousAccess, updatedAccess }
    })
  }

  async function getDeployedWorldCount(): Promise<{ ens: number; dcl: number }> {
    // Count worlds that have at least one scene deployed
    const result = await database.query<{ name: string }>(`
      SELECT w.name
      FROM worlds w
      WHERE w.deployed_scene_count > 0
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
        INNER JOIN world_scenes ws ON ws.world_name = w.name AND ws.status = 'DEPLOYED'
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

  async function undeployWorld(worldName: string): Promise<void> {
    const normalizedWorldName = worldName.toLowerCase()

    await database.withAsyncContextTransaction(async () => {
      // Serialize all scene mutations for this world with deployScene and undeployScene.
      await database.query(SQL`SELECT name FROM worlds WHERE name = ${normalizedWorldName} FOR UPDATE`)

      // Soft-delete all scenes for the world
      await database.query(SQL`
        UPDATE world_scenes SET status = 'UNDEPLOYED', updated_at = NOW()
        WHERE world_name = ${normalizedWorldName} AND status = 'DEPLOYED'
      `)

      // Clear spawn_coordinates and denormalized scene stats since all scenes are removed
      await database.query(SQL`
        UPDATE worlds SET
          spawn_coordinates = NULL,
          last_deployed_at = NULL,
          deployed_scene_count = 0,
          scene_min_x = NULL,
          scene_max_x = NULL,
          scene_min_y = NULL,
          scene_max_y = NULL,
          updated_at = NOW()
        WHERE name = ${normalizedWorldName}
      `)
    })
  }

  async function getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }> {
    // Use the world_permissions table with normalized parcels
    // parcelCount: 0 if any permission is world-wide (no parcels), otherwise the minimum parcel count
    const result = await database.query<{
      name: string
      user_permissions: string[]
      size: string
      owner: string
      parcel_count: string
    }>(SQL`
      SELECT 
        w.name,
        array_agg(DISTINCT wp.permission_type) as user_permissions,
        COALESCE(sizes.total_size, 0)::text as size,
        w.owner,
        CASE 
          WHEN bool_or(COALESCE(parcel_counts.count, 0) = 0) THEN '0'
          ELSE MIN(parcel_counts.count)::text
        END as parcel_count
      FROM world_permissions wp
      JOIN worlds w ON wp.world_name = w.name
      LEFT JOIN (
        SELECT world_name, SUM(size) as total_size
        FROM world_scenes
        WHERE status = 'DEPLOYED'
        GROUP BY world_name
      ) AS sizes ON w.name = sizes.world_name
      LEFT JOIN (
        SELECT permission_id, COUNT(*) as count
        FROM world_permission_parcels
        GROUP BY permission_id
      ) AS parcel_counts ON wp.id = parcel_counts.permission_id
      WHERE LOWER(wp.address) = LOWER(${address})
      GROUP BY w.name, w.owner, sizes.total_size
    `)

    return {
      domains: result.rows.map((row) => ({
        name: row.name,
        user_permissions: row.user_permissions,
        size: row.size,
        owner: row.owner,
        parcelCount: parseInt(row.parcel_count, 10)
      })),
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

    // By default, only return DEPLOYED scenes
    if (!filters?.includeUndeployed) {
      const statusFilter = SQL` AND status = 'DEPLOYED'`
      countQuery.append(statusFilter)
      mainQuery.append(statusFilter)
    }

    // Apply worldName filter
    if (filters?.worldName) {
      const worldNameFilter = SQL` AND world_name = ${filters.worldName.toLowerCase()}`
      countQuery.append(worldNameFilter)
      mainQuery.append(worldNameFilter)
    }

    // Apply entityId filter
    if (filters?.entityId) {
      const entityIdFilter = SQL` AND entity_id = ${filters.entityId}`
      countQuery.append(entityIdFilter)
      mainQuery.append(entityIdFilter)
    }

    // Apply coordinates filter (scenes that contain any of the specified coordinates)
    if (filters?.coordinates && filters.coordinates.length > 0) {
      const canonicalCoordinates = canonicalizeParcels(filters.coordinates)
      const coordinatesFilter = SQL` AND parcels && ${canonicalCoordinates}::text[]`
      countQuery.append(coordinatesFilter)
      mainQuery.append(coordinatesFilter)
    }

    // Apply bounding box filter (scenes that have at least one parcel within the rectangle).
    // LATERAL parses each "x,y" once; EXISTS short-circuits on first matching parcel.
    if (filters?.boundingBox) {
      const { x1, x2, y1, y2 } = filters.boundingBox
      const xMin = Math.min(x1, x2)
      const xMax = Math.max(x1, x2)
      const yMin = Math.min(y1, y2)
      const yMax = Math.max(y1, y2)
      const bboxCondition = SQL` AND EXISTS (
        SELECT 1
        FROM unnest(parcels) AS coord,
             LATERAL (SELECT string_to_array(coord, ',') AS arr) a
        WHERE (a.arr)[1]::int BETWEEN ${xMin} AND ${xMax}
          AND (a.arr)[2]::int BETWEEN ${yMin} AND ${yMax}
      )`
      countQuery.append(bboxCondition)
      mainQuery.append(bboxCondition)
    }

    // Apply authorized_deployer filter: filter by scenes in worlds where deployer is owner or has deployment permission
    // Note: owner and address columns are already stored in lowercase
    if (filters?.authorized_deployer) {
      const normalizedDeployer = filters.authorized_deployer.toLowerCase()
      const deployerCondition = SQL` AND EXISTS (
        SELECT 1 FROM worlds w
        WHERE w.name = world_scenes.world_name
        AND (
          w.owner = ${normalizedDeployer}
          OR EXISTS (
            SELECT 1 FROM world_permissions wp
            WHERE wp.world_name = w.name
            AND wp.address = ${normalizedDeployer}
            AND wp.permission_type = 'deployment'
          )
        )
      )`
      countQuery.append(deployerCondition)
      mainQuery.append(deployerCondition)
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
        status: string
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
      status: row.status as SceneDeploymentStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))

    return { scenes, total }
  }

  async function undeployScene(
    worldName: string,
    parcels: string[],
    authorizedEntityIds?: string[]
  ): Promise<SceneUndeploymentResult> {
    const normalizedWorldName = worldName.toLowerCase()
    const canonicalParcels = canonicalizeParcels(parcels)

    return await database.withAsyncContextTransaction(async () => {
      // Serialize deployment and undeployment for this world. Deployment takes this same lock
      // through its worlds-table upsert before changing scenes or denormalized world state.
      const worldResult = await database.query<{ spawn_coordinates: string | null }>(
        SQL`SELECT spawn_coordinates FROM worlds WHERE name = ${normalizedWorldName} FOR UPDATE`
      )
      const currentSpawnCoordinates = worldResult.rows[0]?.spawn_coordinates

      // Soft-delete only the scene identities authorized from the caller's snapshot. Name owners
      // omit this constraint because their permission covers the whole world.
      const undeployQuery = SQL`
        UPDATE world_scenes SET status = 'UNDEPLOYED', updated_at = NOW()
        WHERE world_name = ${normalizedWorldName}
        AND parcels && ${canonicalParcels}::text[]
        AND status = 'DEPLOYED'
      `
      if (authorizedEntityIds) {
        undeployQuery.append(SQL` AND entity_id = ANY(${authorizedEntityIds}::text[])`)
      }
      undeployQuery.append(SQL` RETURNING entity_id, entity->'metadata'->'scene'->>'base' AS declared_base, parcels`)
      const undeployedResult = await database.query<{
        entity_id: string
        declared_base: string | null
        parcels: string[]
      }>(undeployQuery)

      // Calculate new bounding rectangle (after deletion) using the shared function
      const boundingRectangle = await getWorldBoundingRectangle(normalizedWorldName)

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
        await database.query(SQL`
          UPDATE worlds SET spawn_coordinates = ${newSpawnCoordinates} WHERE name = ${normalizedWorldName}
        `)
      }

      // Update denormalized scene stats
      await recalculateWorldSceneStats(normalizedWorldName)

      const scenes = undeployedResult.rows.map((row) => ({
        entityId: row.entity_id,
        declaredBase: row.declared_base,
        parcels: row.parcels
      }))

      return { scenes }
    })
  }

  async function updateWorldSettings(
    worldName: string,
    owner: EthAddress,
    settings: WorldSettings
  ): Promise<UpdateWorldSettingsResult> {
    return await database.withAsyncContextTransaction(async () => {
      // A spawn coordinate is validated against the world's deployed shape, so the row lock has to
      // be held across validation and the write: deploy and undeploy take that same lock before
      // touching world_scenes. FOR UPDATE locks nothing when the row does not exist yet, so
      // materialize it first in that case — otherwise a concurrent first deploy could create the
      // shape after the unlocked read and an undeploy could shrink it again before the write lands.
      // A failed validation throws and rolls this row back with the rest of the transaction.
      if (settings.spawnCoordinates) {
        await createBasicWorldIfNotExists(worldName, owner)
      }

      const oldSettingsResult = await database.query<{ spawn_coordinates: string | null }>(SQL`
        SELECT spawn_coordinates FROM worlds WHERE name = ${worldName.toLowerCase()} FOR UPDATE
      `)
      const oldSpawnCoordinates = oldSettingsResult.rows[0]?.spawn_coordinates || null

      // If spawn coordinates are being set, validate against bounding rectangle
      if (settings.spawnCoordinates) {
        const boundingRectangle = await getWorldBoundingRectangle(worldName)

        if (!boundingRectangle) {
          throw new NoDeployedScenesError(worldName)
        }

        const spawnCoord = parseCoordinate(settings.spawnCoordinates)
        const isWithinBounds = isCoordinateWithinRectangle(spawnCoord, boundingRectangle)

        if (!isWithinBounds) {
          throw new SpawnCoordinatesOutOfBoundsError(settings.spawnCoordinates, boundingRectangle)
        }
      }

      // Only what the request actually sent reaches the patch: an omitted field keeps its stored
      // value, while an explicitly null one clears the column (a cleared list is stored as an empty
      // array, since the column never holds NULL).
      const ownerPatch: WorldSettingsPatch = {
        ...(settings.title === undefined ? {} : { title: settings.title }),
        ...(settings.description === undefined ? {} : { description: settings.description }),
        ...(settings.contentRating === undefined ? {} : { contentRating: settings.contentRating }),
        ...(settings.skyboxTime === undefined ? {} : { skyboxTime: settings.skyboxTime }),
        ...(settings.categories === undefined ? {} : { categories: settings.categories ?? [] }),
        ...(settings.singlePlayer === undefined ? {} : { singlePlayer: settings.singlePlayer }),
        ...(settings.showInPlaces === undefined ? {} : { showInPlaces: settings.showInPlaces }),
        ...(settings.thumbnailHash === undefined ? {} : { thumbnailHash: settings.thumbnailHash })
      }
      const now = new Date()
      const ownerAssignments = buildSettingsAssignments(ownerPatch, now)

      // The row is created with what the request supplied and, when it already exists, updated with
      // the same patch the deploy path uses, so both share one definition of a settings write.
      const upsert = SQL`
        INSERT INTO worlds (
          name, owner, access,
          title, description, content_rating, spawn_coordinates,
          skybox_time, categories, single_player, show_in_places, thumbnail_hash,
          created_at, updated_at
        )
        VALUES (
          ${worldName.toLowerCase()},
          ${owner.toLowerCase()},
          ${JSON.stringify(defaultAccess())}::json,
          ${settings.title ?? null},
          ${settings.description ?? null},
          ${settings.contentRating ?? null},
          ${settings.spawnCoordinates ?? null},
          ${settings.skyboxTime ?? null},
          ${settings.categories === null ? [] : (settings.categories ?? null)}::text[],
          ${settings.singlePlayer ?? null},
          ${settings.showInPlaces ?? null},
          ${settings.thumbnailHash ?? null},
          ${now},
          ${now}
        )
        ON CONFLICT (name) DO UPDATE SET
          spawn_coordinates = COALESCE(EXCLUDED.spawn_coordinates, worlds.spawn_coordinates)`

      if (ownerAssignments) {
        upsert.append(SQL`, `).append(ownerAssignments)
      } else {
        upsert.append(SQL`, updated_at = ${now}`)
      }

      const result = await database.query<WorldRecord>(upsert.append(SQL` RETURNING *`))

      return {
        settings: mapWorldRecordToSettings(result.rows[0]),
        oldSpawnCoordinates
      }
    })
  }

  async function getWorldSettings(worldName: string): Promise<WorldSettings | undefined> {
    const result = await database.query<WorldRecord>(SQL`
      SELECT title, description, content_rating, spawn_coordinates, skybox_time,
             categories, single_player, show_in_places, thumbnail_hash, access, settings_version
      FROM worlds WHERE name = ${worldName.toLowerCase()}
    `)

    if (result.rowCount === 0) {
      return undefined
    }

    return mapWorldRecordToSettings(result.rows[0])
  }

  function mapWorldRecordToSettings(row: Partial<WorldRecord>): WorldSettings {
    return {
      title: row.title || undefined,
      description: row.description || undefined,
      contentRating: row.content_rating || undefined,
      spawnCoordinates: row.spawn_coordinates || undefined,
      // Null is reported as null rather than collapsed to undefined, so a mirror can tell "the owner
      // cleared the fixed skybox" from "this response says nothing about it" and clear its own copy.
      skyboxTime: row.skybox_time === undefined ? undefined : row.skybox_time,
      // An empty array already means "cleared" here, so it survives as-is; only a missing column is
      // reported as absent.
      categories: row.categories || undefined,
      // NULL means neither the owner nor any scene expressed a preference, so report the effective
      // default. The distinction only matters for storage, where NULL is what lets a scene that
      // omits these fields preserve whatever the owner configured.
      singlePlayer: row.single_player === null ? false : row.single_player,
      showInPlaces: row.show_in_places === null ? true : row.show_in_places,
      thumbnailHash: row.thumbnail_hash || undefined,
      // Exposed alongside the version so a mirror derives visibility from authoritative state
      // instead of an event payload, which has no ordering relationship with this version.
      accessType: row.access?.type,
      // BIGINT arrives as a string from node-postgres. The column is BIGINT for headroom, but the
      // value is a per-world change counter, so it stays far below Number.MAX_SAFE_INTEGER and the
      // conversion is exact for any reachable value.
      settingsVersion: row.settings_version === undefined ? undefined : Number(row.settings_version)
    }
  }

  async function getTotalWorldSize(worldName: string): Promise<bigint> {
    const result = await database.query<{ total_size: string }>(SQL`
      SELECT COALESCE(SUM(size), 0) as total_size
      FROM world_scenes
      WHERE world_name = ${worldName.toLowerCase()}
      AND status = 'DEPLOYED'
    `)

    return BigInt(result.rows[0]?.total_size || 0)
  }

  /**
   * Returns the total size of the world's currently deployed scenes that overlap any of the
   * given parcels — i.e. the scenes a deployment on those parcels would replace.
   */
  async function getDeployedSceneSizeForParcels(worldName: string, parcels: string[]): Promise<bigint> {
    if (parcels.length === 0) {
      return 0n
    }

    const canonicalParcels = canonicalizeParcels(parcels)
    const result = await database.query<{ total_size: string }>(SQL`
      SELECT COALESCE(SUM(size), 0) as total_size
      FROM world_scenes
      WHERE world_name = ${worldName.toLowerCase()}
      AND status = 'DEPLOYED'
      AND parcels && ${canonicalParcels}::text[]
    `)

    return BigInt(result.rows[0]?.total_size || 0)
  }

  /**
   * Gets the bounding rectangle for all deployed scenes in a world
   * Computed directly in SQL to avoid fetching all parcels
   *
   * @param worldName - The name of the world
   * @returns The bounding rectangle, or undefined if no parcels exist
   */
  function buildRecalculateWorldSceneStatsQuery(worldName: string): SQLStatement {
    return SQL`
      WITH stats AS (
        SELECT
          MAX(ws.created_at) as last_deployed_at,
          COUNT(DISTINCT ws.entity_id)::integer as scene_count,
          MIN(SPLIT_PART(parcel, ',', 1)::integer) as min_x,
          MAX(SPLIT_PART(parcel, ',', 1)::integer) as max_x,
          MIN(SPLIT_PART(parcel, ',', 2)::integer) as min_y,
          MAX(SPLIT_PART(parcel, ',', 2)::integer) as max_y
        FROM world_scenes ws, UNNEST(ws.parcels) as parcel
        WHERE ws.world_name = ${worldName}
        AND ws.status = 'DEPLOYED'
      )
      UPDATE worlds SET
        last_deployed_at = stats.last_deployed_at,
        deployed_scene_count = COALESCE(stats.scene_count, 0),
        scene_min_x = stats.min_x,
        scene_max_x = stats.max_x,
        scene_min_y = stats.min_y,
        scene_max_y = stats.max_y,
        updated_at = NOW()
      FROM stats
      WHERE worlds.name = ${worldName}
    `
  }

  async function recalculateWorldSceneStats(worldName: string): Promise<void> {
    await database.query(buildRecalculateWorldSceneStatsQuery(worldName))
  }

  async function getWorldBoundingRectangle(worldName: string): Promise<WorldBoundingRectangle | undefined> {
    const query = SQL`
      SELECT 
        MIN(SPLIT_PART(parcel, ',', 1)::integer) as min_x,
        MAX(SPLIT_PART(parcel, ',', 1)::integer) as max_x,
        MIN(SPLIT_PART(parcel, ',', 2)::integer) as min_y,
        MAX(SPLIT_PART(parcel, ',', 2)::integer) as max_y
      FROM world_scenes, UNNEST(parcels) as parcel
      WHERE world_name = ${worldName.toLowerCase()}
      AND status = 'DEPLOYED'
    `

    const { rows } = await database.query<BoundingRow>(query)

    const row = rows[0]
    if (!row || row.min_x === null || row.max_x === null || row.min_y === null || row.max_y === null) {
      return undefined
    }

    return {
      min: { x: row.min_x, y: row.min_y },
      max: { x: row.max_x, y: row.max_y }
    }
  }

  /**
   * Gets a paginated list of worlds with optional search, sorting, and authorized_deployer filtering
   *
   * @param filters - Optional filters for search and authorized_deployer address
   * @param options - Pagination and sorting options
   * @returns Paginated list of worlds with total count
   */
  async function getWorlds(filters: GetWorldsFilters = {}, options: GetWorldsOptions = {}): Promise<GetWorldsResult> {
    const { search: searchTerm, authorized_deployer, has_deployed_scenes } = filters
    const { limit = 100, offset = 0, orderBy = WorldsOrderBy.Name, orderDirection = OrderDirection.Asc } = options

    // Get banned names to exclude from query
    const bannedNames = await nameDenyListChecker.getBannedNames()

    // Build base count query
    const countQuery = SQL`
      SELECT COUNT(*) as total
      FROM worlds w
      WHERE 1=1
    `

    // Build the main query using denormalized columns on worlds table
    const mainQuery = SQL`
      SELECT
        w.name,
        w.owner,
        w.title,
        w.description,
        w.content_rating,
        w.spawn_coordinates,
        w.skybox_time,
        w.categories,
        -- NULL means nothing set a preference; expose the effective default so the listing keeps
        -- reporting plain booleans
        COALESCE(w.single_player, false) as single_player,
        COALESCE(w.show_in_places, true) as show_in_places,
        w.thumbnail_hash,
        w.last_deployed_at,
        w.scene_min_x as min_x,
        w.scene_max_x as max_x,
        w.scene_min_y as min_y,
        w.scene_max_y as max_y,
        b.created_at as blocked_since,
        w.deployed_scene_count as deployed_scenes
      FROM worlds w
      LEFT JOIN blocked b ON w.owner = b.wallet
      WHERE 1=1
    `

    // Exclude banned names from both queries
    if (bannedNames.length > 0) {
      const bannedFilter = SQL` AND w.name != ALL(${bannedNames})`
      countQuery.append(bannedFilter)
      mainQuery.append(bannedFilter)
    }

    // Apply authorized_deployer filter: filter by worlds where deployer is owner or has deployment permission
    // Note: owner and address columns are already stored in lowercase
    if (authorized_deployer) {
      const normalizedDeployer = authorized_deployer.toLowerCase()
      const deployerFilter = SQL` AND (
        w.owner = ${normalizedDeployer}
        OR EXISTS (
          SELECT 1 FROM world_permissions wp
          WHERE wp.world_name = w.name
          AND wp.address = ${normalizedDeployer}
          AND wp.permission_type = 'deployment'
        )
      )`
      countQuery.append(deployerFilter)
      mainQuery.append(deployerFilter)
    }

    // Apply has_deployed_scenes filter using denormalized count
    if (has_deployed_scenes !== undefined) {
      if (has_deployed_scenes) {
        const hasDeployedFilter = SQL` AND w.deployed_scene_count > 0`
        countQuery.append(hasDeployedFilter)
        mainQuery.append(hasDeployedFilter)
      } else {
        const noDeployedFilter = SQL` AND w.deployed_scene_count = 0`
        countQuery.append(noDeployedFilter)
        mainQuery.append(noDeployedFilter)
      }
    }

    // Apply combined full-text search and trigram search filter to both queries
    if (searchTerm && searchTerm.trim().length > 0) {
      // Build the ILIKE and similarity filter
      const likeFilter = await search.buildLikeSearchFilter(searchTerm, [
        { column: 'w.name', nullable: false },
        { column: 'w.title', nullable: true },
        { column: 'w.description', nullable: true }
      ])

      // Combine full-text search with ILIKE/similarity filter
      const searchFilter = SQL` AND (
            w.search_vector @@ plainto_tsquery('english', ${searchTerm})
            OR `
      searchFilter.append(likeFilter)
      searchFilter.append(SQL`
          )`)

      countQuery.append(searchFilter)
      mainQuery.append(searchFilter)
    }

    // Add ordering
    // Using safe string interpolation since orderBy and orderDirection are enum values
    if (orderBy === WorldsOrderBy.LastDeployedAt) {
      // 1. IS NULL ASC ensures worlds without deployments are always at the end regardless of sort direction
      // 2. Non-null last_deployed_at values are sorted by the requested direction
      // 3. Null last_deployed_at worlds are then sorted by name ASC for deterministic ordering
      mainQuery.append(
        ` ORDER BY w.last_deployed_at IS NULL ASC, w.last_deployed_at ${orderDirection.toUpperCase()}, w.name ASC`
      )
    } else {
      mainQuery.append(` ORDER BY w.name ${orderDirection.toUpperCase()}`)
    }

    // Apply pagination
    mainQuery.append(SQL` LIMIT ${limit} OFFSET ${offset}`)

    type WorldRow = {
      name: string
      owner: string
      title: string | null
      description: string | null
      content_rating: string | null
      spawn_coordinates: string | null
      skybox_time: number | null
      categories: string[] | null
      single_player: boolean | null
      show_in_places: boolean | null
      thumbnail_hash: string | null
      last_deployed_at: Date | null
      min_x: number | null
      max_x: number | null
      min_y: number | null
      max_y: number | null
      blocked_since: Date | null
      deployed_scenes: number
    }

    // Execute both queries concurrently
    const [countResult, result] = await Promise.all([
      database.query<{ total: string }>(countQuery),
      database.query<WorldRow>(mainQuery)
    ])

    const total = parseInt(countResult.rows[0]?.total || '0', 10)

    const worlds: WorldInfo[] = result.rows.map((row) => ({
      name: row.name,
      owner: row.owner,
      title: row.title,
      description: row.description,
      contentRating: row.content_rating,
      spawnCoordinates: row.spawn_coordinates,
      skyboxTime: row.skybox_time,
      categories: row.categories,
      singlePlayer: row.single_player,
      showInPlaces: row.show_in_places,
      thumbnailHash: row.thumbnail_hash,
      shape:
        row.min_x !== null && row.max_x !== null && row.min_y !== null && row.max_y !== null
          ? {
              x1: row.min_x,
              x2: row.max_x,
              y1: row.min_y,
              y2: row.max_y
            }
          : null,
      lastDeployedAt: row.last_deployed_at,
      blockedSince: row.blocked_since,
      deployedScenes: row.deployed_scenes
    }))

    return { worlds, total }
  }

  /**
   * Gets occupied parcels for a world with pagination, sorted by x,y coordinates
   *
   * This method performs a single efficient SQL query that:
   * 1. Retrieves all unique parcels from world_scenes using UNNEST
   * 2. Returns parcels sorted by x,y coordinates with pagination
   * 3. Includes total count using window function
   *
   * @param worldName - The name of the world
   * @param options - Pagination options (limit, offset)
   * @returns Object with parcels array and total count
   */
  async function getOccupiedParcels(
    worldName: string,
    options?: GetOccupiedParcelsOptions
  ): Promise<GetOccupiedParcelsResult> {
    const normalizedWorldName = worldName.toLowerCase()
    const { limit, offset } = options ?? {}

    // Build count query
    const countQuery = SQL`
      SELECT COUNT(DISTINCT parcel)::text as total
      FROM world_scenes ws
      CROSS JOIN UNNEST(ws.parcels) as parcel
      WHERE ws.world_name = ${normalizedWorldName}
      AND ws.status = 'DEPLOYED'
    `

    // Build main query for parcels
    const mainQuery = SQL`
      SELECT parcel
      FROM (
        SELECT DISTINCT parcel
        FROM world_scenes ws
        CROSS JOIN UNNEST(ws.parcels) as parcel
        WHERE ws.world_name = ${normalizedWorldName}
        AND ws.status = 'DEPLOYED'
      ) unique_parcels
      ORDER BY 
        SPLIT_PART(parcel, ',', 1)::integer,
        SPLIT_PART(parcel, ',', 2)::integer
    `
      .append(limit !== undefined ? SQL` LIMIT ${limit}` : SQL``)
      .append(offset !== undefined ? SQL` OFFSET ${offset}` : SQL``)

    // Execute both queries concurrently
    const [countResult, result] = await Promise.all([
      database.query<{ total: string }>(countQuery),
      database.query<{ parcel: string }>(mainQuery)
    ])

    const total = parseInt(countResult.rows[0]?.total || '0', 10)

    return {
      parcels: result.rows.map((row) => row.parcel),
      total
    }
  }

  /**
   * Ensures a world record exists in the database, creating a minimal entry if it doesn't.
   * Uses INSERT ... ON CONFLICT DO NOTHING so it is safe to call when the world already exists.
   *
   * @param worldName - The name of the world
   * @param owner - The Ethereum address of the world owner
   */
  async function createBasicWorldIfNotExists(worldName: string, owner: EthAddress): Promise<void> {
    await database.query(SQL`
      INSERT INTO worlds (name, owner, access, created_at, updated_at)
      VALUES (${worldName.toLowerCase()}, ${owner.toLowerCase()}, ${JSON.stringify(defaultAccess())}::jsonb, ${new Date()}, ${new Date()})
      ON CONFLICT (name) DO NOTHING
    `)
  }

  /**
   * Checks whether a world record exists in the database.
   *
   * @param worldName - The name of the world to check
   * @returns true if the world exists, false otherwise
   */
  async function worldExists(worldName: string): Promise<boolean> {
    const result = await database.query<{ exists: boolean }>(SQL`
      SELECT EXISTS(SELECT 1 FROM worlds WHERE name = ${worldName.toLowerCase()}) as exists
    `)
    return result.rows[0]?.exists ?? false
  }

  /**
   * Finds all world names whose access settings use the given community ID
   * in their allow-list communities array.
   *
   * @param communityId - The community ID to search for
   * @returns Array of world names that reference this community
   */
  async function evictUndeployedScenes(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const result = await database.query(SQL`
      DELETE FROM world_scenes
      WHERE status = 'UNDEPLOYED' AND updated_at < ${cutoff}
    `)
    return result.rowCount ?? 0
  }

  async function getWorldNamesByCommunityId(communityId: string): Promise<string[]> {
    const result = await database.query<{ name: string }>(SQL`
      SELECT name FROM worlds
      WHERE access->>'type' = 'allow-list'
        AND access->'communities' @> ${JSON.stringify([communityId])}::jsonb
    `)
    return result.rows.map((row) => row.name)
  }

  return {
    getRawWorldRecords,
    getDeployedWorldCount,
    getMetadataForWorld,
    getEntityForWorlds,
    deployScene,
    undeployScene,
    storeAccess,
    modifyAccessAtomically,
    undeployWorld,
    getContributableDomains,
    getWorldScenes,
    updateWorldSettings,
    getWorldSettings,
    getTotalWorldSize,
    getDeployedSceneSizeForParcels,
    getWorldBoundingRectangle,
    getWorlds,
    getOccupiedParcels,
    createBasicWorldIfNotExists,
    worldExists,
    getWorldNamesByCommunityId,
    evictUndeployedScenes
  }
}
