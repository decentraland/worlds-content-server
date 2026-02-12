import { AppComponents, IPermissionsManager, ParcelsResult } from '../types'
import { AllowListPermission, WorldPermissionRecord, WorldPermissionRecordForChecking } from '../logic/permissions'
import { EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'

export async function createPermissionsManagerComponent({
  database,
  logs,
  nameOwnership,
  worldsManager
}: Pick<AppComponents, 'database' | 'logs' | 'nameOwnership' | 'worldsManager'>): Promise<IPermissionsManager> {
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
    const lowerCaseAddresses = addresses.map((a) => a.toLowerCase())
    const now = new Date()

    const client = await database.getPool().connect()

    try {
      await client.query('BEGIN')

      // Build batch insert query (skips existing, returns only newly inserted)
      const insertQuery = SQL`
        INSERT INTO world_permissions (world_name, permission_type, address, created_at, updated_at)
        VALUES `

      lowerCaseAddresses.forEach((address, index) => {
        if (index > 0) {
          insertQuery.append(SQL`, `)
        }
        insertQuery.append(SQL`(${lowerCaseWorldName}, ${permission}, ${address}, ${now}, ${now})`)
      })

      insertQuery.append(SQL`
        ON CONFLICT (world_name, permission_type, address) DO NOTHING
        RETURNING address
      `)

      const insertResult = await client.query<{ address: string }>(insertQuery)
      const newlyAddedAddresses = insertResult.rows.map((r) => r.address)

      // Delete any existing parcels for ALL addresses (making them world-wide)
      // This affects both new and existing addresses
      await client.query(SQL`
        DELETE FROM world_permission_parcels
        WHERE permission_id IN (
          SELECT id FROM world_permissions
          WHERE world_name = ${lowerCaseWorldName}
            AND permission_type = ${permission}
            AND address = ANY(${lowerCaseAddresses})
        )
      `)

      await client.query('COMMIT')

      return newlyAddedAddresses
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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
    const now = new Date()

    const client = await database.getPool().connect()

    try {
      await client.query('BEGIN')

      // Check if permission exists
      const existingResult = await client.query<{ id: number }>(SQL`
        SELECT id FROM world_permissions
        WHERE world_name = ${lowerCaseWorldName}
          AND permission_type = ${permission}
          AND address = ${lowerCaseAddress}
      `)

      let permissionId: number
      let created = false

      if (existingResult.rowCount === 0) {
        // Create new permission
        const insertResult = await client.query<{ id: number }>(SQL`
          INSERT INTO world_permissions (world_name, permission_type, address, created_at, updated_at)
          VALUES (${lowerCaseWorldName}, ${permission}, ${lowerCaseAddress}, ${now}, ${now})
          RETURNING id
        `)
        permissionId = insertResult.rows[0].id
        created = true
      } else {
        permissionId = existingResult.rows[0].id
        // Update timestamp
        await client.query(SQL`
          UPDATE world_permissions 
          SET updated_at = ${now} 
          WHERE id = ${permissionId}
        `)
      }

      // Add parcels if any
      if (parcels.length > 0) {
        const insertQuery = SQL`
          INSERT INTO world_permission_parcels (permission_id, parcel)
          VALUES `

        parcels.forEach((parcel, index) => {
          if (index > 0) {
            insertQuery.append(SQL`, `)
          }
          insertQuery.append(SQL`(${permissionId}, ${parcel})`)
        })

        insertQuery.append(SQL` ON CONFLICT DO NOTHING`)

        await client.query(insertQuery)
      }

      await client.query('COMMIT')
      return { created }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Remove parcels from an existing permission.
   */
  async function removeParcelsFromPermission(permissionId: number, parcels: string[]): Promise<void> {
    if (parcels.length === 0) {
      return
    }

    const client = await database.getPool().connect()

    try {
      await client.query('BEGIN')

      await client.query(SQL`
        DELETE FROM world_permission_parcels 
        WHERE permission_id = ${permissionId} 
          AND parcel = ANY(${parcels})
      `)

      // Update the permission's updated_at timestamp
      await client.query(SQL`
        UPDATE world_permissions 
        SET updated_at = ${new Date()} 
        WHERE id = ${permissionId}
      `)

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return {
    getOwner,
    grantAddressesWorldWidePermission,
    removeAddressesPermission,
    getAddressPermissions,
    getParcelsForPermission,
    getWorldPermissionRecords,
    checkParcelsAllowed,
    hasPermissionEntries,
    addParcelsToPermission,
    removeParcelsFromPermission
  }
}
