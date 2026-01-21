import { WorldPermissions, PermissionType } from './types'

const _defaultPermissions: WorldPermissions = {
  deployment: {
    type: PermissionType.AllowList,
    wallets: []
  },
  streaming: {
    type: PermissionType.AllowList,
    wallets: []
  }
}

export function defaultPermissions(): WorldPermissions {
  return JSON.parse(JSON.stringify(_defaultPermissions))
}
