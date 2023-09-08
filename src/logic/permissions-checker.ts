import { AccessPermissionSetting, IPermissionChecker, Permission, Permissions, PermissionType } from '../types'
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

export function createPermissionChecker(permissions: Permissions): IPermissionChecker {
  const checkers: Record<Permission, CheckingFunction> = {
    deployment: createPermissionCheckFrom(permissions.deployment),
    access: createPermissionCheckFrom(permissions.access),
    streaming: createPermissionCheckFrom(permissions.streaming)
  }

  function checkPermission(permission: Permission, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    return Promise.resolve(checkers[permission](ethAddress, extras))
  }

  return { checkPermission }
}
