import {
  AccessPermissionSetting,
  AllowListPermission,
  IPermissionChecker,
  Permission,
  Permissions,
  PermissionType,
  WorldPermissionRecord
} from '../types'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'

const _defaultPermissions: Permissions = {
  deployment: {
    type: PermissionType.AllowList,
    wallets: []
  },
  access: {
    type: PermissionType.Unrestricted
  },
  streaming: {
    type: PermissionType.AllowList,
    wallets: []
  }
}

export function defaultPermissions(): Permissions {
  return JSON.parse(JSON.stringify(_defaultPermissions))
}

type CheckingFunction = (ethAddress: EthAddress, extras?: any) => Promise<boolean>

function createUnrestrictedPermissionChecker(): CheckingFunction {
  return (_ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
    return Promise.resolve(true)
  }
}

function createSharedSecretChecker(hashedSharedSecret: string): CheckingFunction {
  return (_ethAddress: EthAddress, plainTextSecret: string): Promise<boolean> => {
    return bcrypt.compare(plainTextSecret, hashedSharedSecret)
  }
}

function createNftOwnershipChecker(_requiredNft: string): CheckingFunction {
  return (_ethAddress: EthAddress): Promise<boolean> => {
    // TODO Check NFT ownership in the blockchain
    return Promise.resolve(false)
  }
}

function createAllowListChecker(allowList: string[]): CheckingFunction {
  const lowerCasedAllowList = allowList.map((ethAddress) => ethAddress.toLowerCase())
  return (ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
    return Promise.resolve(lowerCasedAllowList.includes(ethAddress.toLowerCase()))
  }
}

function createPermissionCheckFrom(
  permissionCheck: AccessPermissionSetting
): (ethAddress: EthAddress, permission: Permission) => Promise<boolean> {
  switch (permissionCheck.type) {
    case PermissionType.Unrestricted:
      return createUnrestrictedPermissionChecker()
    case PermissionType.SharedSecret:
      return createSharedSecretChecker(permissionCheck.secret)
    case PermissionType.NFTOwnership:
      return createNftOwnershipChecker(permissionCheck.nft)
    case PermissionType.AllowList:
      return createAllowListChecker(permissionCheck.wallets)
    default:
      throw new Error(`Invalid permission type.`)
  }
}

/**
 * Check if a set of target parcels is allowed given a permission record.
 * - If record.parcels is null, the user has world-wide permission (all parcels allowed)
 * - If record.parcels is an array, check if all target parcels are in the allowed set
 */
export function checkParcelsAllowed(targetParcels: string[], allowedParcels: string[] | null): boolean {
  // null means world-wide permission
  if (allowedParcels === null) {
    return true
  }

  // Check if all target parcels are in the allowed set
  const allowedSet = new Set(allowedParcels)
  return targetParcels.every((parcel) => allowedSet.has(parcel))
}

/**
 * Creates a permission checker that uses the new world_permissions table records.
 * This is used for checking deployment/streaming permissions with parcel granularity.
 */
export function createPermissionCheckerWithRecords(
  permissions: Permissions,
  permissionRecords: WorldPermissionRecord[]
): IPermissionChecker {
  // Group records by permission type and address for efficient lookup
  const recordsByTypeAndAddress = new Map<string, WorldPermissionRecord>()
  for (const record of permissionRecords) {
    const key = `${record.permissionType}:${record.address.toLowerCase()}`
    recordsByTypeAndAddress.set(key, record)
  }

  // For access permission, use the old checker (it doesn't support parcels)
  const accessChecker = createPermissionCheckFrom(permissions.access)

  function checkPermission(permission: Permission, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    if (permission === 'access') {
      return accessChecker(ethAddress, extras)
    }

    // For deployment and streaming, check the world_permissions records
    const key = `${permission}:${ethAddress.toLowerCase()}`
    const record = recordsByTypeAndAddress.get(key)

    if (!record) {
      return Promise.resolve(false)
    }

    // If no parcels restriction, user has world-wide permission
    return Promise.resolve(true)
  }

  function checkPermissionForParcels(
    permission: AllowListPermission,
    ethAddress: EthAddress,
    parcels: string[]
  ): Promise<boolean> {
    const key = `${permission}:${ethAddress.toLowerCase()}`
    const record = recordsByTypeAndAddress.get(key)

    if (!record) {
      return Promise.resolve(false)
    }

    return Promise.resolve(checkParcelsAllowed(parcels, record.parcels))
  }

  return { checkPermission, checkPermissionForParcels }
}

/**
 * Legacy permission checker that doesn't support parcel-based permissions.
 * Used for backward compatibility and when permission records are not available.
 */
export function createPermissionChecker(permissions: Permissions): IPermissionChecker {
  const checkers: Record<Permission, CheckingFunction> = {
    deployment: createPermissionCheckFrom(permissions.deployment),
    access: createPermissionCheckFrom(permissions.access),
    streaming: createPermissionCheckFrom(permissions.streaming)
  }

  function checkPermission(permission: Permission, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    return Promise.resolve(checkers[permission](ethAddress, extras))
  }

  function checkPermissionForParcels(
    permission: AllowListPermission,
    ethAddress: EthAddress,
    _parcels: string[]
  ): Promise<boolean> {
    // Legacy checker doesn't support parcels - just check if user has world-wide permission
    return checkPermission(permission, ethAddress)
  }

  return { checkPermission, checkPermissionForParcels }
}
