import { AppComponents, IPermissionsManager, Permission, PermissionType } from '../types'
import { defaultPermissions } from '../logic/permissions-checker'
import bcrypt from 'bcrypt'

const saltRounds = 10

export async function createPermissionsManagerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IPermissionsManager> {
  async function setPermissionType(
    worldName: string,
    permission: Permission,
    type: PermissionType,
    extras: any
  ): Promise<void> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    const extraOptions: any = {}
    if (type === PermissionType.SharedSecret) {
      extraOptions.secret = bcrypt.hashSync(extras.secret, saltRounds)
    } else if (type === PermissionType.NFTOwnership) {
      extraOptions.nft = extras.nft
    } else if (type === PermissionType.AllowList) {
      extraOptions.wallets = []
    }

    const permissions = metadata?.permissions || defaultPermissions()
    permissions[permission] = { type, ...extraOptions }
    await worldsManager.storePermissions(worldName, permissions)
  }

  async function addAddressToAllowList(worldName: string, permission: Permission, address: string): Promise<void> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    if (!metadata) {
      throw new Error(`World ${worldName} does not exist`)
    }

    const permissionSetting = metadata.permissions[permission]
    if (permissionSetting.type !== PermissionType.AllowList) {
      throw new Error(`Permission ${permission} is not an allow list`)
    }

    if (!permissionSetting.wallets.includes(address)) {
      permissionSetting.wallets.push(address)
    }
    await worldsManager.storePermissions(worldName, metadata.permissions)
  }

  async function deleteAddressFromAllowList(worldName: string, permission: Permission, address: string): Promise<void> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    if (!metadata) {
      throw new Error(`World ${worldName} does not exist`)
    }

    const permissionSetting = metadata.permissions[permission]
    if (permissionSetting.type !== PermissionType.AllowList) {
      throw new Error(`Permission ${permission} is not an allow list`)
    }

    if (permissionSetting.wallets.includes(address)) {
      permissionSetting.wallets = permissionSetting.wallets.filter((w) => w !== address)
    }
    await worldsManager.storePermissions(worldName, metadata.permissions)
  }

  return {
    setPermissionType,
    addAddressToAllowList,
    deleteAddressFromAllowList
  }
}
