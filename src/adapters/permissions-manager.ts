import { AppComponents, IPermissionsManager, Permission, PermissionType, Permissions } from '../types'
import { defaultPermissions } from '../logic/permissions-checker'

export async function createPermissionsManagerComponent({
  worldsManager
}: Pick<AppComponents, 'worldsManager'>): Promise<IPermissionsManager> {
  async function getPermissions(worldName: string): Promise<Permissions> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    return metadata?.permissions || defaultPermissions()
  }

  async function storePermissions(worldName: string, permissions: Permissions): Promise<void> {
    await worldsManager.storePermissions(worldName, permissions)
  }

  async function addAddressToAllowList(worldName: string, permission: Permission, address: string): Promise<void> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)

    const permissions = metadata?.permissions || defaultPermissions()
    const permissionSetting = permissions[permission]
    if (permissionSetting.type !== PermissionType.AllowList) {
      throw new Error(`Permission ${permission} is not an allow list`)
    }

    if (!permissionSetting.wallets.includes(address)) {
      permissionSetting.wallets.push(address)
    }
    await worldsManager.storePermissions(worldName, permissions)
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
    getPermissions,
    storePermissions,
    addAddressToAllowList,
    deleteAddressFromAllowList
  }
}
