import { EthAddress } from '@dcl/schemas'

export enum PermissionType {
  Unrestricted = 'unrestricted',
  AllowList = 'allow-list'
}

export type PermissionTypeName = 'access' | 'deployment' | 'streaming'

export type UnrestrictedPermissionSetting = {
  type: PermissionType.Unrestricted
}

export type AllowListPermissionSetting = {
  type: PermissionType.AllowList
  wallets: string[]
}

export type WorldPermissions = {
  deployment: AllowListPermissionSetting
  streaming: UnrestrictedPermissionSetting | AllowListPermissionSetting
}

// Alias for backward compatibility
export type Permissions = WorldPermissions

export type Permission = keyof WorldPermissions

// AllowListPermission is a subset of Permission that only includes permissions that can be allow-list based
export type AllowListPermission = 'deployment' | 'streaming'

// Record stored in world_permissions table
export type WorldPermissionRecord = {
  id: number
  worldName: string
  permissionType: AllowListPermission
  address: string
  createdAt: Date
  updatedAt: Date
}

// Permission record for checking (lightweight - doesn't load all parcels)
// isWorldWide is true when no rows exist in world_permission_parcels
// parcelCount is the number of parcels the address has permission for (0 if world-wide)
export type WorldPermissionRecordForChecking = WorldPermissionRecord & {
  isWorldWide: boolean
  parcelCount: number
}

// Permission record with resolved parcels (only used when parcels are actually needed)
// parcels is null when world-wide (no rows in world_permission_parcels), otherwise contains the parcel array
export type WorldPermissionRecordWithParcels = WorldPermissionRecord & {
  parcels: string[] | null
}

// Summary of a single permission for an address
export type AddressPermissionSummary = {
  permission: AllowListPermission
  worldWide: boolean
  parcelCount?: number
}

// Summary of all permissions grouped by address
export type WorldPermissionsSummary = Record<string, AddressPermissionSummary[]>

// Permissions component for checking and managing permissions (logic layer)
export type IPermissionsComponent = {
  hasPermissionForParcels(
    worldName: string,
    permission: AllowListPermission,
    ethAddress: EthAddress,
    parcels: string[]
  ): Promise<boolean>
  hasWorldWidePermission(worldName: string, permission: AllowListPermission, ethAddress: EthAddress): Promise<boolean>
  grantWorldWidePermission(
    worldName: string,
    permission: AllowListPermission,
    wallets: string[],
    owner?: EthAddress
  ): Promise<void>
  revokePermission(worldName: string, permission: AllowListPermission, addresses: string[]): Promise<void>
  setDeploymentPermission(worldName: string, owner: EthAddress, type: PermissionType, wallets: string[]): Promise<void>
  setStreamingPermission(worldName: string, owner: EthAddress, type: PermissionType, wallets?: string[]): Promise<void>
  addParcelsToPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<void>
  removeParcelsFromPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<void>
  getAllowedParcelsForPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    limit?: number,
    offset?: number,
    boundingBox?: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<{ total: number; results: string[] }>
  getPermissionsSummary(worldName: string): Promise<WorldPermissionsSummary>
}
