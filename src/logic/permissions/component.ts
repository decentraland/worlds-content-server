import { AppComponents } from '../../types'
import { AllowListPermission, IPermissionsComponent, PermissionType, WorldPermissionsSummary } from './types'
import { PermissionNotFoundError } from './errors'
import { EthAddress, Events, WorldsPermissionGrantedEvent, WorldsPermissionRevokedEvent } from '@dcl/schemas'
import { randomUUID } from 'crypto'
import { InvalidRequestError } from '@dcl/http-commons'

export async function createPermissionsComponent({
  config,
  permissionsManager,
  snsClient
}: Pick<AppComponents, 'config' | 'permissionsManager' | 'snsClient'>): Promise<IPermissionsComponent> {
  const builderUrl = await config.requireString('BUILDER_URL')
  const snsArn = await config.requireString('SNS_ARN')

  /**
   * Sends a WorldsPermissionGrantedEvent notification.
   */
  async function sendPermissionGrantedNotification(
    worldName: string,
    permission: AllowListPermission,
    address: string
  ): Promise<void> {
    const notificationId = randomUUID()
    const event: WorldsPermissionGrantedEvent = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLDS_PERMISSION_GRANTED,
      key: `worlds-permission-granted-${notificationId}`,
      timestamp: Date.now(),
      metadata: {
        title: 'World Permission Granted',
        description: `You have been granted ${permission} permission for world ${worldName}.`,
        url: `${builderUrl}/worlds?tab=dcl`,
        world: worldName,
        permissions: [permission],
        address: address.toLowerCase()
      }
    }

    await snsClient.publishMessage({
      Message: JSON.stringify(event),
      TopicArn: snsArn
    })
  }

  /**
   * Sends a WorldsPermissionRevokedEvent notification.
   */
  async function sendPermissionRevokedNotification(
    worldName: string,
    permission: AllowListPermission,
    address: string
  ): Promise<void> {
    const notificationId = randomUUID()
    const event: WorldsPermissionRevokedEvent = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLDS_PERMISSION_REVOKED,
      key: `worlds-permission-revoked-${notificationId}`,
      timestamp: Date.now(),
      metadata: {
        title: 'World Permission Revoked',
        description: `Your ${permission} permission for world ${worldName} has been revoked.`,
        url: `${builderUrl}/worlds?tab=dcl`,
        world: worldName,
        permissions: [permission],
        address: address.toLowerCase()
      }
    }

    await snsClient.publishMessage({
      Message: JSON.stringify(event),
      TopicArn: snsArn
    })
  }

  /**
   * Checks if an address has permission to perform an action on specific parcels.
   *
   * This function validates that the address has permission for ALL the specified parcels.
   * It returns true if:
   * - The address has world-wide permission (no parcel restrictions), OR
   * - The address has parcel-specific permission that includes ALL the target parcels
   *
   * Use this function when you need to verify permissions for specific coordinates,
   * such as during scene deployment or undeployment.
   *
   * @param worldName - The name of the world to check permissions for
   * @param permission - The type of permission to check ('deployment' or 'streaming')
   * @param ethAddress - The Ethereum address to check permissions for
   * @param parcels - Array of parcel coordinates (e.g., ['0,0', '1,0']) to validate against
   * @returns Promise resolving to true if the address has permission for all parcels, false otherwise
   */
  async function hasPermissionForParcels(
    worldName: string,
    permission: AllowListPermission,
    ethAddress: EthAddress,
    parcels: string[]
  ): Promise<boolean> {
    // If world-wide permission, all parcels are allowed
    if (await hasWorldWidePermission(worldName, permission, ethAddress)) {
      return true
    }

    // Otherwise, check parcel-specific permissions
    const permissionRecords = await permissionsManager.getWorldPermissionRecords(worldName)
    const key = `${permission}:${ethAddress.toLowerCase()}`
    const record = permissionRecords.find((r) => `${r.permissionType}:${r.address.toLowerCase()}` === key)

    if (!record) {
      return false
    }

    // Check in the database if all target parcels are allowed
    return permissionsManager.checkParcelsAllowed(record.id, parcels)
  }

  /**
   * Checks if an address has world-wide permission (no parcel restrictions) for a world.
   *
   * This function verifies that the address has a permission record with no parcel restrictions,
   * meaning they can perform the action on any parcel in the world.
   *
   * Use this function when the operation affects the entire world (e.g., undeploying a whole world)
   * and should only be allowed for users with unrestricted access.
   *
   * @param worldName - The name of the world to check permissions for
   * @param permission - The type of permission to check ('deployment' or 'streaming')
   * @param ethAddress - The Ethereum address to check permissions for
   * @returns Promise resolving to true if the address has world-wide permission, false otherwise
   */
  async function hasWorldWidePermission(
    worldName: string,
    permission: AllowListPermission,
    ethAddress: EthAddress
  ): Promise<boolean> {
    const permissionRecords = await permissionsManager.getWorldPermissionRecords(worldName)

    const key = `${permission}:${ethAddress.toLowerCase()}`
    const record = permissionRecords.find((r) => `${r.permissionType}:${r.address.toLowerCase()}` === key)

    if (!record) {
      return false
    }

    return record.isWorldWide
  }

  /**
   * Grants world-wide permission to multiple wallets for a world.
   * Sends a notification to each wallet about the granted permission.
   *
   * @param worldName - The name of the world
   * @param permission - The type of permission ('deployment' or 'streaming')
   * @param wallets - Array of wallet addresses to grant world-wide permission to
   */
  async function grantWorldWidePermission(
    worldName: string,
    permission: AllowListPermission,
    wallets: string[]
  ): Promise<void> {
    if (wallets.length === 0) {
      return
    }

    // Batch insert all addresses and get the ones that were actually added
    const addedAddresses = await permissionsManager.grantAddressesWorldWidePermission(worldName, permission, wallets)

    // Send notifications only to addresses that were actually added
    for (const address of addedAddresses) {
      await sendPermissionGrantedNotification(worldName, permission, address)
    }
  }

  /**
   * Revokes permission from multiple addresses for a world.
   * Sends a notification to each address about the revoked permission.
   *
   * @param worldName - The name of the world
   * @param permission - The type of permission ('deployment' or 'streaming')
   * @param addresses - Array of addresses to revoke permission from
   */
  async function revokePermission(
    worldName: string,
    permission: AllowListPermission,
    addresses: string[]
  ): Promise<void> {
    if (addresses.length === 0) {
      return
    }

    // Batch delete all addresses and get the ones that were actually deleted
    const deletedAddresses = await permissionsManager.removeAddressesPermission(worldName, permission, addresses)

    // Send notifications only to addresses that were actually deleted
    for (const address of deletedAddresses) {
      await sendPermissionRevokedNotification(worldName, permission, address)
    }
  }

  /**
   * Sets deployment permission for a world. Deployment is always allow-list.
   * Replaces all existing deployment wallets with the provided ones.
   *
   * @param worldName - The name of the world
   * @param type - Must be 'allow-list' for deployment
   * @param wallets - Array of wallet addresses to grant deployment permission
   */
  async function setDeploymentPermission(worldName: string, type: PermissionType, wallets: string[]): Promise<void> {
    if (type !== PermissionType.AllowList) {
      throw new InvalidRequestError(
        `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
      )
    }

    const lowerCaseWorldName = worldName.toLowerCase()

    // Get current deployment wallets
    const currentRecords = await permissionsManager.getWorldPermissionRecords(worldName)
    const currentDeploymentAddresses = currentRecords
      .filter((r) => r.permissionType === 'deployment')
      .map((r) => r.address.toLowerCase())

    const newWallets = wallets.map((w) => w.toLowerCase())

    // Remove wallets that are no longer in the list
    const walletsToRemove = currentDeploymentAddresses.filter((address) => !newWallets.includes(address))
    if (walletsToRemove.length > 0) {
      await revokePermission(lowerCaseWorldName, 'deployment', walletsToRemove)
    }

    // Add new wallets
    const walletsToAdd = newWallets.filter((wallet) => !currentDeploymentAddresses.includes(wallet))
    if (walletsToAdd.length > 0) {
      await grantWorldWidePermission(lowerCaseWorldName, 'deployment', walletsToAdd)
    }
  }

  /**
   * Sets streaming permission for a world.
   *
   * @param worldName - The name of the world
   * @param type - Either 'unrestricted' or 'allow-list'
   * @param wallets - Array of wallet addresses (only used when type is 'allow-list')
   */
  async function setStreamingPermission(worldName: string, type: PermissionType, wallets?: string[]): Promise<void> {
    if (type !== PermissionType.Unrestricted && type !== PermissionType.AllowList) {
      throw new InvalidRequestError(
        `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
      )
    }

    const lowerCaseWorldName = worldName.toLowerCase()

    // Get current streaming wallets
    const currentRecords = await permissionsManager.getWorldPermissionRecords(worldName)
    const currentStreamingAddresses = currentRecords
      .filter((r) => r.permissionType === 'streaming')
      .map((r) => r.address.toLowerCase())

    if (type === PermissionType.Unrestricted) {
      // Remove all streaming entries to make it unrestricted
      if (currentStreamingAddresses.length > 0) {
        await revokePermission(lowerCaseWorldName, 'streaming', currentStreamingAddresses)
      }
    } else {
      // Allow-list mode - replace wallets
      const newWallets = (wallets || []).map((w) => w.toLowerCase())

      // Remove wallets that are no longer in the list
      const walletsToRemove = currentStreamingAddresses.filter((address) => !newWallets.includes(address))
      if (walletsToRemove.length > 0) {
        await revokePermission(lowerCaseWorldName, 'streaming', walletsToRemove)
      }

      // Add new wallets
      const walletsToAdd = newWallets.filter((wallet) => !currentStreamingAddresses.includes(wallet))
      if (walletsToAdd.length > 0) {
        await grantWorldWidePermission(lowerCaseWorldName, 'streaming', walletsToAdd)
      }
    }
  }

  /**
   * Adds parcels to a permission, creating the permission if it doesn't exist.
   * Sends a notification if the permission was newly created.
   *
   * @param worldName - The name of the world
   * @param permission - The type of permission ('deployment' or 'streaming')
   * @param address - The Ethereum address to add parcels for
   * @param parcels - Array of parcel coordinates to add
   */
  async function addParcelsToPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<void> {
    const { created } = await permissionsManager.addParcelsToPermission(worldName, permission, address, parcels)

    // Send notification if permission was newly created
    if (created) {
      await sendPermissionGrantedNotification(worldName, permission, address)
    }
  }

  /**
   * Removes parcels from an existing permission.
   * The permission must already exist for this address.
   *
   * @param worldName - The name of the world
   * @param permission - The type of permission ('deployment' or 'streaming')
   * @param address - The Ethereum address to remove parcels from
   * @param parcels - Array of parcel coordinates to remove
   */
  async function removeParcelsFromPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<void> {
    const existingPermission = await permissionsManager.getAddressPermissions(worldName, permission, address)

    if (!existingPermission) {
      throw new InvalidRequestError(
        `Permission not found. Address ${address} does not have ${permission} permission for world ${worldName}.`
      )
    }

    await permissionsManager.removeParcelsFromPermission(existingPermission.id, parcels)
  }

  /**
   * Gets allowed parcels for a specific address permission with pagination.
   * Throws PermissionNotFoundError if the permission doesn't exist.
   *
   * @param worldName - The name of the world
   * @param permission - The type of permission ('deployment' or 'streaming')
   * @param address - The Ethereum address to get parcels for
   * @param limit - Maximum number of parcels to return
   * @param offset - Number of parcels to skip
   * @param boundingBox - Optional bounding box to filter parcels
   * @returns Paginated result with total count and parcel array
   * @throws PermissionNotFoundError if the address doesn't have the permission
   */
  async function getAllowedParcelsForPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    limit?: number,
    offset?: number,
    boundingBox?: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<{ total: number; results: string[] }> {
    const existingPermission = await permissionsManager.getAddressPermissions(worldName, permission, address)

    if (!existingPermission) {
      throw new PermissionNotFoundError(worldName, permission, address)
    }

    return permissionsManager.getParcelsForPermission(existingPermission.id, limit, offset, boundingBox)
  }

  /**
   * Gets a summary of all permissions for a world, grouped by address.
   * Each address has an array of permissions with their type and scope (world-wide or parcel count).
   *
   * @param worldName - The name of the world
   * @returns A record mapping addresses to their permission summaries
   */
  async function getPermissionsSummary(worldName: string): Promise<WorldPermissionsSummary> {
    const records = await permissionsManager.getWorldPermissionRecords(worldName)

    const summary: WorldPermissionsSummary = {}

    for (const record of records) {
      if (!summary[record.address]) {
        summary[record.address] = []
      }

      summary[record.address].push({
        permission: record.permissionType,
        worldWide: record.isWorldWide,
        ...(record.isWorldWide ? {} : { parcelCount: record.parcelCount })
      })
    }

    return summary
  }

  return {
    hasPermissionForParcels,
    hasWorldWidePermission,
    grantWorldWidePermission,
    revokePermission,
    setDeploymentPermission,
    setStreamingPermission,
    addParcelsToPermission,
    removeParcelsFromPermission,
    getAllowedParcelsForPermission,
    getPermissionsSummary
  }
}
