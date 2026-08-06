import { AppComponents, IPermissionsManager, PaginatedResult, ParcelsResult } from '../types'
import { AllowListPermission, WorldPermissionRecord, WorldPermissionRecordForChecking } from '../logic/permissions'
import { EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'

export async function createPermissionsManagerComponent({
  coordinates,
  database,
  logs,
  nameOwnership,
  worldsManager
}: Pick<
  AppComponents,
  'coordinates' | 'database' | 'logs' | 'nameOwnership' | 'worldsManager'
>): Promise<IPermissionsManager> {
  const logger = logs.getLogger('permissions-manager')

  async function getOwner(worldName: string): Promise<EthAddress | undefined> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    if (metadata?.owner) {
      return metadata.owner
    }

    try {
      const owners = await nameOwnership.findOwners([worldName])
      return owners.get(worldName)
    } catch (error: any) {
      logger.warn(`Failed to resolve owner for world ${worldName} via nameOwnership: ${error.message}`)
      return undefined
    }
  }

  /**
   * Resolve the owner a permission is being granted under, so it can be recorded alongside the
   * permission itself.
   *
   * This deliberately does not go through `getOwner`: that one prefers the `worlds.owner` column,
   * which is only refreshed by the update owner job. Stamping a grant with a stale owner would
   * make the very next run of that job delete a permission the current owner had just granted.
   *
   * Returns undefined when the owner cannot be resolved, which records the grant as being of
   * unknown provenance and gets it cleaned up on the next ownership change.
   */
  async function resolveGrantingOwner(worldName: string): Promise<EthAddress | undefined> {
    try {
      const owners = await nameOwnership.findOwners([worldName])
      return owners?.get(worldName)?.toLowerCase()
    } catch (error: any) {
      logger.warn(`Failed to resolve the current owner of world ${worldName}: ${error.message}`)
      return undefined
    }
  }

  /**
   * Add multiple addresses to the permitted list for a permission with world-wide access.
   * If addresses already exist, their parcels are removed to make them world-wide.
   * Returns the addresses that were newly added (for notifications).
   */
  async function grantAddressesWorldWidePermission(
    worldName: string,
    permission: AllowListPermission,
    addresses: string[]
  ): Promise<string[]> {
    if (addresses.length === 0) {
      return []
    }

    const lowerCaseWorldName = worldName.toLowerCase()
    // Deduplicated because `ON CONFLICT DO UPDATE` rejects a statement that proposes the same
    // conflicting row twice, and the callers build this list straight from user supplied wallets.
    const lowerCaseAddresses = [...new Set(addresses.map((a) => a.toLowerCase()))]
    const now = new Date()
    // Resolved before opening the transaction so the network call does not hold a pooled client.
    const grantedUnderOwner = await resolveGrantingOwner(worldName)

    return await database.withAsyncContextTransaction(async () => {
      // Build batch insert query. Existing rows have their granting owner refreshed: re-granting
      // an address is an explicit act by whoever owns the name now, so the permission belongs to
      // the current owner even if a previous one had originally granted it.
      const insertQuery = SQL`
        INSERT INTO world_permissions (world_name, permission_type, address, granted_under_owner, created_at, updated_at)
        VALUES `

      lowerCaseAddresses.forEach((address, index) => {
        if (index > 0) {
          insertQuery.append(SQL`, `)
        }
        insertQuery.append(
          SQL`(${lowerCaseWorldName}, ${permission}, ${address}, ${grantedUnderOwner ?? null}, ${now}, ${now})`
        )
      })

      // `xmax = 0` is only true for tuples this statement inserted, so it separates the rows that
      // were newly added (which must be notified) from the ones that were merely refreshed.
      // COALESCE keeps the recorded owner when it could not be resolved now: downgrading a known
      // provenance to unknown would get the permission deleted on the next ownership change.
      insertQuery.append(SQL`
        ON CONFLICT (world_name, permission_type, address) DO UPDATE
          SET granted_under_owner = COALESCE(EXCLUDED.granted_under_owner, world_permissions.granted_under_owner),
              updated_at = EXCLUDED.updated_at
        RETURNING address, (xmax = 0) AS inserted
      `)

      const insertResult = await database.query<{ address: string; inserted: boolean }>(insertQuery)
      const newlyAddedAddresses = insertResult.rows.filter((r) => r.inserted).map((r) => r.address)

      // Delete any existing parcels for ALL addresses (making them world-wide)
      // This affects both new and existing addresses
      await database.query(SQL`
        DELETE FROM world_permission_parcels
        WHERE permission_id IN (
          SELECT id FROM world_permissions
          WHERE world_name = ${lowerCaseWorldName}
            AND permission_type = ${permission}
            AND address = ANY(${lowerCaseAddresses})
        )
      `)

      return newlyAddedAddresses
    })
  }

  /**
   * Delete multiple addresses from the permitted list for a permission.
   * Returns the addresses that were actually deleted.
   */
  async function removeAddressesPermission(
    worldName: string,
    permission: AllowListPermission,
    addresses: string[]
  ): Promise<string[]> {
    if (addresses.length === 0) {
      return []
    }

    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddresses = addresses.map((a) => a.toLowerCase())

    // Delete from world_permissions table (cascades to world_permission_parcels)
    const result = await database.query<{ address: string }>(SQL`
      DELETE FROM world_permissions 
      WHERE world_name = ${lowerCaseWorldName} 
        AND permission_type = ${permission} 
        AND address = ANY(${lowerCaseAddresses})
      RETURNING address
    `)

    return result.rows.map((r) => r.address)
  }

  /**
   * Re-record the owner the given permissions are held under.
   *
   * The flows that replace a whole allow-list only remove the addresses that dropped out and grant
   * the ones that came in, so an address kept across the change is never written to. Without this,
   * its recorded owner would still be a previous one and the update owner job would revoke a
   * permission that the current owner explicitly kept in the list they just submitted.
   *
   * Does nothing when the owner cannot be resolved, so a failed lookup never downgrades a known
   * provenance to unknown.
   */
  async function refreshGrantingOwner(
    worldName: string,
    permission: AllowListPermission,
    addresses: string[]
  ): Promise<void> {
    if (addresses.length === 0) {
      return
    }

    const grantedUnderOwner = await resolveGrantingOwner(worldName)
    if (!grantedUnderOwner) {
      return
    }

    await database.query(SQL`
      UPDATE world_permissions
      SET granted_under_owner = ${grantedUnderOwner},
          updated_at = ${new Date()}
      WHERE world_name = ${worldName.toLowerCase()}
        AND permission_type = ${permission}
        AND address = ANY(${addresses.map((a) => a.toLowerCase())})
    `)
  }

  /**
   * Delete every permission of a world that was not granted under the given owner.
   *
   * Used when a name changes hands: permissions the previous owner handed out must not survive the
   * transfer, while the ones the new owner already granted must. Rows whose granting owner is
   * unknown (NULL) are deleted too, since their provenance cannot be established and leaving a
   * stale permission in place is worse than making the new owner grant it again.
   *
   * Parcels are removed as well through the `world_permission_parcels` foreign key cascade.
   *
   * @returns The permissions that were deleted.
   */
  async function deletePermissionsNotGrantedUnderOwner(
    worldName: string,
    owner: EthAddress
  ): Promise<{ address: string; permissionType: AllowListPermission }[]> {
    const result = await database.query<{ address: string; permission_type: string }>(SQL`
      DELETE FROM world_permissions
      WHERE world_name = ${worldName.toLowerCase()}
        AND granted_under_owner IS DISTINCT FROM ${owner.toLowerCase()}
      RETURNING address, permission_type
    `)

    return result.rows.map((r) => ({
      address: r.address,
      permissionType: r.permission_type as AllowListPermission
    }))
  }

  async function getAddressPermissions(
    worldName: string,
    permission: AllowListPermission,
    address: string
  ): Promise<WorldPermissionRecord | undefined> {
    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddress = address.toLowerCase()

    const result = await database.query<{
      id: number
      world_name: string
      permission_type: string
      address: string
      created_at: Date
      updated_at: Date
    }>(SQL`
      SELECT id, world_name, permission_type, address, created_at, updated_at
      FROM world_permissions 
      WHERE world_name = ${lowerCaseWorldName} 
        AND permission_type = ${permission} 
        AND address = ${lowerCaseAddress}
    `)

    if (result.rowCount === 0) {
      return undefined
    }

    const row = result.rows[0]
    return {
      id: row.id,
      worldName: row.world_name,
      permissionType: row.permission_type as AllowListPermission,
      address: row.address,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  /**
   * Get paginated parcels for a specific permission by permission ID.
   * Optionally filters by a bounding box defined by two opposite corners (x1,y1) and (x2,y2).
   */
  async function getParcelsForPermission(
    permissionId: number,
    limit?: number,
    offset?: number,
    boundingBox?: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<ParcelsResult> {
    // Calculate min/max for bounding box
    const hasBoundingBox = boundingBox !== undefined
    const minX = hasBoundingBox ? Math.min(boundingBox.x1, boundingBox.x2) : 0
    const maxX = hasBoundingBox ? Math.max(boundingBox.x1, boundingBox.x2) : 0
    const minY = hasBoundingBox ? Math.min(boundingBox.y1, boundingBox.y2) : 0
    const maxY = hasBoundingBox ? Math.max(boundingBox.y1, boundingBox.y2) : 0

    // Build paginated parcels query
    const parcelsQuery = SQL`
      SELECT parcel
      FROM world_permission_parcels
      WHERE permission_id = ${permissionId}
    `

    // Add bounding box filter if provided
    if (hasBoundingBox) {
      parcelsQuery.append(SQL`
        AND SPLIT_PART(parcel, ',', 1)::int >= ${minX}
        AND SPLIT_PART(parcel, ',', 1)::int <= ${maxX}
        AND SPLIT_PART(parcel, ',', 2)::int >= ${minY}
        AND SPLIT_PART(parcel, ',', 2)::int <= ${maxY}
      `)
    }

    parcelsQuery.append(SQL` ORDER BY parcel`)

    if (limit !== undefined) {
      parcelsQuery.append(SQL` LIMIT ${limit}`)
    }

    if (offset !== undefined) {
      parcelsQuery.append(SQL` OFFSET ${offset}`)
    }

    // Build count query with same filters
    const countQuery = SQL`
      SELECT COUNT(*)::text as parcel_count
      FROM world_permission_parcels
      WHERE permission_id = ${permissionId}
    `

    if (hasBoundingBox) {
      countQuery.append(SQL`
        AND SPLIT_PART(parcel, ',', 1)::int >= ${minX}
        AND SPLIT_PART(parcel, ',', 1)::int <= ${maxX}
        AND SPLIT_PART(parcel, ',', 2)::int >= ${minY}
        AND SPLIT_PART(parcel, ',', 2)::int <= ${maxY}
      `)
    }

    // Run both queries concurrently
    const [countResult, parcelsResult] = await Promise.all([
      database.query<{ parcel_count: string }>(countQuery),
      database.query<{ parcel: string }>(parcelsQuery)
    ])

    const totalCount = parseInt(countResult.rows[0].parcel_count, 10)

    return {
      total: totalCount,
      results: parcelsResult.rows.map((r) => r.parcel)
    }
  }

  /**
   * Get permission records for a world with world-wide flag and parcel count (lightweight - no parcels loaded).
   * isWorldWide is true when no rows exist in world_permission_parcels.
   * parcelCount is the number of parcels the address has permission for (0 if world-wide).
   */
  async function getWorldPermissionRecords(worldName: string): Promise<WorldPermissionRecordForChecking[]> {
    const result = await database.query<{
      id: number
      world_name: string
      permission_type: string
      address: string
      created_at: Date
      updated_at: Date
      is_world_wide: boolean
      parcel_count: string
    }>(SQL`
      SELECT 
        wp.id,
        wp.world_name,
        wp.permission_type,
        wp.address,
        wp.created_at,
        wp.updated_at,
        COUNT(wpp.parcel) = 0 as is_world_wide,
        COUNT(wpp.parcel)::text as parcel_count
      FROM world_permissions wp
      LEFT JOIN world_permission_parcels wpp ON wp.id = wpp.permission_id
      WHERE wp.world_name = ${worldName.toLowerCase()}
      GROUP BY wp.id, wp.world_name, wp.permission_type, wp.address, wp.created_at, wp.updated_at
    `)

    return result.rows.map((row) => ({
      id: row.id,
      worldName: row.world_name,
      permissionType: row.permission_type as AllowListPermission,
      address: row.address,
      isWorldWide: row.is_world_wide,
      parcelCount: parseInt(row.parcel_count, 10),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  /**
   * Check if all target parcels are allowed for a given permission.
   */
  async function checkParcelsAllowed(permissionId: number, parcels: string[]): Promise<boolean> {
    const result = await database.query<{ count: string }>(SQL`
      SELECT COUNT(*)::text as count
      FROM world_permission_parcels
      WHERE permission_id = ${permissionId}
        AND parcel = ANY(${parcels})
    `)

    const matchingCount = parseInt(result.rows[0].count, 10)

    // All target parcels must be in the allowed set
    return matchingCount === parcels.length
  }

  /**
   * Check if there are any permission entries for a world and permission type.
   * Used to determine if streaming is unrestricted (no entries) or allow-list (has entries).
   */
  async function hasPermissionEntries(worldName: string, permission: AllowListPermission): Promise<boolean> {
    const result = await database.query<{ exists: boolean }>(SQL`
      SELECT EXISTS(
        SELECT 1 FROM world_permissions 
        WHERE world_name = ${worldName.toLowerCase()} 
          AND permission_type = ${permission}
      ) as exists
    `)
    return result.rows[0]?.exists ?? false
  }

  /**
   * Add parcels to a permission, creating the permission if it doesn't exist.
   * Ignores duplicate parcels.
   * Returns whether the permission was newly created.
   */
  async function addParcelsToPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<{ created: boolean }> {
    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddress = address.toLowerCase()
    const canonicalParcels = coordinates.canonicalizeParcels(parcels)
    const now = new Date()
    // Resolved before opening the transaction so the network call does not hold a pooled client.
    const grantedUnderOwner = await resolveGrantingOwner(worldName)

    return await database.withAsyncContextTransaction(async () => {
      // Check if permission exists
      const existingResult = await database.query<{ id: number }>(SQL`
        SELECT id FROM world_permissions
        WHERE world_name = ${lowerCaseWorldName}
          AND permission_type = ${permission}
          AND address = ${lowerCaseAddress}
      `)

      let permissionId: number
      let created = false

      if (existingResult.rowCount === 0) {
        // Create new permission
        const insertResult = await database.query<{ id: number }>(SQL`
          INSERT INTO world_permissions (world_name, permission_type, address, granted_under_owner, created_at, updated_at)
          VALUES (${lowerCaseWorldName}, ${permission}, ${lowerCaseAddress}, ${grantedUnderOwner ?? null}, ${now}, ${now})
          RETURNING id
        `)
        permissionId = insertResult.rows[0].id
        created = true
      } else {
        permissionId = existingResult.rows[0].id
        // Update timestamp, and re-stamp the granting owner: widening an existing permission is an
        // explicit act by whoever owns the name now. The recorded owner is kept when it could not
        // be resolved now, so a failed lookup never downgrades a known provenance to unknown.
        await database.query(SQL`
          UPDATE world_permissions
          SET updated_at = ${now},
              granted_under_owner = COALESCE(${grantedUnderOwner ?? null}::varchar, granted_under_owner)
          WHERE id = ${permissionId}
        `)
      }

      // Add parcels if any
      if (canonicalParcels.length > 0) {
        const insertQuery = SQL`
          INSERT INTO world_permission_parcels (permission_id, parcel)
          VALUES `

        canonicalParcels.forEach((parcel, index) => {
          if (index > 0) {
            insertQuery.append(SQL`, `)
          }
          insertQuery.append(SQL`(${permissionId}, ${parcel})`)
        })

        insertQuery.append(SQL` ON CONFLICT DO NOTHING`)

        await database.query(insertQuery)
      }

      return { created }
    })
  }

  /**
   * Remove parcels from an existing permission.
   */
  async function removeParcelsFromPermission(permissionId: number, parcels: string[]): Promise<void> {
    if (parcels.length === 0) {
      return
    }

    const canonicalParcels = coordinates.canonicalizeParcels(parcels)

    await database.withAsyncContextTransaction(async () => {
      await database.query(SQL`
        DELETE FROM world_permission_parcels
        WHERE permission_id = ${permissionId}
          AND parcel = ANY(${canonicalParcels})
      `)

      // Update the permission's updated_at timestamp
      await database.query(SQL`
        UPDATE world_permissions 
        SET updated_at = ${new Date()} 
        WHERE id = ${permissionId}
      `)
    })
  }

  /**
   * Get paginated addresses that have a given permission for any of the specified parcels.
   * An address qualifies if it has world-wide permission (no parcel rows) or
   * has at least one of the parcels in world_permission_parcels.
   */
  async function getAddressesForParcelPermission(
    worldName: string,
    permission: AllowListPermission,
    parcels: string[],
    limit?: number,
    offset?: number
  ): Promise<PaginatedResult<string>> {
    const lowerCaseWorldName = worldName.toLowerCase()

    function buildWhereClause() {
      return SQL`
        WHERE wp.world_name = ${lowerCaseWorldName}
          AND wp.permission_type = ${permission}
          AND (
            NOT EXISTS (
              SELECT 1 FROM world_permission_parcels wpp WHERE wpp.permission_id = wp.id
            )
            OR EXISTS (
              SELECT 1 FROM world_permission_parcels wpp
              WHERE wpp.permission_id = wp.id AND wpp.parcel = ANY(${parcels})
            )
          )
      `
    }

    const countQuery = SQL`SELECT COUNT(*)::text as count FROM world_permissions wp`
    countQuery.append(buildWhereClause())

    const addressQuery = SQL`SELECT wp.address FROM world_permissions wp`
    addressQuery.append(buildWhereClause())
    addressQuery.append(SQL` ORDER BY wp.address`)

    if (limit !== undefined) {
      addressQuery.append(SQL` LIMIT ${limit}`)
    }

    if (offset !== undefined) {
      addressQuery.append(SQL` OFFSET ${offset}`)
    }

    const [countResult, addressResult] = await Promise.all([
      database.query<{ count: string }>(countQuery),
      database.query<{ address: string }>(addressQuery)
    ])

    return {
      total: parseInt(countResult.rows[0].count, 10),
      results: addressResult.rows.map((r) => r.address)
    }
  }

  return {
    getOwner,
    grantAddressesWorldWidePermission,
    removeAddressesPermission,
    refreshGrantingOwner,
    deletePermissionsNotGrantedUnderOwner,
    getAddressPermissions,
    getParcelsForPermission,
    getWorldPermissionRecords,
    checkParcelsAllowed,
    hasPermissionEntries,
    addParcelsToPermission,
    removeParcelsFromPermission,
    getAddressesForParcelPermission
  }
}
