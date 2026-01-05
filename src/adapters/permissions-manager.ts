import {
  AllowListPermission,
  AppComponents,
  IPermissionsManager,
  PermissionType,
  Permissions,
  WorldPermissionRecord
} from '../types'
import { defaultPermissions } from '../logic/permissions-checker'
import { EthAddress } from '@dcl/schemas/dist/misc'
import SQL from 'sql-template-strings'

export async function createPermissionsManagerComponent({
  database,
  worldsManager
}: Pick<AppComponents, 'database' | 'worldsManager'>): Promise<IPermissionsManager> {
  async function getPermissions(worldName: string): Promise<Permissions> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    return metadata?.permissions || defaultPermissions()
  }

  async function getOwner(worldName: string): Promise<EthAddress | undefined> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    return metadata?.owner
  }

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    await worldsManager.storePermissions(worldName, permissions)
  }

  /**
   * Add an address to the allow list for a permission.
   * @param parcels - Optional array of parcels. If null/undefined, grants world-wide permission.
   */
  async function addAddressToAllowList(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels?: string[]
  ): Promise<void> {
    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddress = address.toLowerCase()
    const now = new Date()

    // Insert into world_permissions table
    await database.query(SQL`
      INSERT INTO world_permissions (world_name, permission_type, address, parcels, created_at, updated_at)
      VALUES (${lowerCaseWorldName}, ${permission}, ${lowerCaseAddress}, ${parcels || null}::text[], ${now}, ${now})
      ON CONFLICT (world_name, permission_type, address) 
      DO UPDATE SET parcels = ${parcels || null}::text[], updated_at = ${now}
    `)

    // Also update the legacy JSON permissions for backward compatibility
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    const permissions = metadata?.permissions || defaultPermissions()
    const permissionSetting = permissions[permission]

    if (permissionSetting.type === PermissionType.AllowList) {
      if (!permissionSetting.wallets.includes(lowerCaseAddress)) {
        permissionSetting.wallets.push(lowerCaseAddress)
      }
      await worldsManager.storePermissions(worldName, permissions)
    }
  }

  async function deleteAddressFromAllowList(
    worldName: string,
    permission: AllowListPermission,
    address: string
  ): Promise<void> {
    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddress = address.toLowerCase()

    // Delete from world_permissions table
    await database.query(SQL`
      DELETE FROM world_permissions 
      WHERE world_name = ${lowerCaseWorldName} 
        AND permission_type = ${permission} 
        AND address = ${lowerCaseAddress}
    `)

    // Also update the legacy JSON permissions for backward compatibility
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    if (!metadata) {
      return
    }

    const permissionSetting = metadata.permissions[permission]
    if (permissionSetting.type === PermissionType.AllowList) {
      if (permissionSetting.wallets.includes(lowerCaseAddress)) {
        permissionSetting.wallets = permissionSetting.wallets.filter((w) => w !== lowerCaseAddress)
      }
      await worldsManager.storePermissions(worldName, metadata.permissions)
    }
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
      parcels: string[] | null
      created_at: Date
      updated_at: Date
    }>(SQL`
      SELECT * FROM world_permissions 
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
      parcels: row.parcels,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  async function getWorldPermissions(
    worldName: string,
    permission: AllowListPermission
  ): Promise<WorldPermissionRecord[]> {
    const lowerCaseWorldName = worldName.toLowerCase()

    const result = await database.query<{
      id: number
      world_name: string
      permission_type: string
      address: string
      parcels: string[] | null
      created_at: Date
      updated_at: Date
    }>(SQL`
      SELECT * FROM world_permissions 
      WHERE world_name = ${lowerCaseWorldName} 
        AND permission_type = ${permission}
      ORDER BY created_at
    `)

    return result.rows.map((row) => ({
      id: row.id,
      worldName: row.world_name,
      permissionType: row.permission_type as AllowListPermission,
      address: row.address,
      parcels: row.parcels,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async function updateAddressParcels(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[] | null
  ): Promise<void> {
    const lowerCaseWorldName = worldName.toLowerCase()
    const lowerCaseAddress = address.toLowerCase()
    const now = new Date()

    await database.query(SQL`
      UPDATE world_permissions 
      SET parcels = ${parcels}::text[], updated_at = ${now}
      WHERE world_name = ${lowerCaseWorldName} 
        AND permission_type = ${permission} 
        AND address = ${lowerCaseAddress}
    `)
  }

  return {
    getPermissions,
    getOwner,
    storePermissions,
    addAddressToAllowList,
    deleteAddressFromAllowList,
    getAddressPermissions,
    getWorldPermissions,
    updateAddressParcels
  }
}
