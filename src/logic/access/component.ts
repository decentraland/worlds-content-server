import { AppComponents } from '../../types'
import { AccessInput, AccessSetting, AccessType, IAccessComponent } from './types'
import { EthAddress, Events, WorldSettingsChangedEvent } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { defaultAccess, DEFAULT_MAX_COMMUNITIES, DEFAULT_MAX_WALLETS, SALT_ROUNDS } from './constants'
import {
  InvalidAccessTypeError,
  InvalidAllowListSettingError,
  NotAllowListAccessError,
  UnauthorizedCommunityError
} from './errors'

export async function createAccessComponent({
  config,
  socialService,
  worldsManager,
  accessChangeHandler,
  accessChecker,
  snsClient
}: Pick<
  AppComponents,
  'config' | 'socialService' | 'worldsManager' | 'accessChangeHandler' | 'accessChecker' | 'snsClient'
>): Promise<IAccessComponent> {
  const maxCommunities = (await config.getNumber('ACCESS_MAX_COMMUNITIES')) ?? DEFAULT_MAX_COMMUNITIES
  const maxWallets = (await config.getNumber('ACCESS_MAX_WALLETS')) ?? DEFAULT_MAX_WALLETS

  /**
   * Gets the access setting for a world using the faster getRawWorldRecords method.
   * Returns the default access (unrestricted) if the world doesn't exist or has no access defined.
   *
   * @param worldName - The name of the world
   * @returns The access setting for the world, or defaultAccess() if the world doesn't exist
   */
  async function getAccessForWorld(worldName: string): Promise<AccessSetting> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })
    if (records.length === 0) {
      return defaultAccess()
    }
    return records[0].access || defaultAccess()
  }

  function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    return accessChecker.checkAccess(worldName, ethAddress, extras)
  }

  /**
   * Set access settings for a world with validation.
   * Validates the access type and constructs the appropriate AccessSetting.
   * For AllowList with communities, validates that the signer is a member of all communities.
   * After storing the new access, handles the access change (e.g. kicks participants when required).
   */
  async function setAccess(worldName: string, signer: EthAddress, input: AccessInput): Promise<void> {
    const { type, wallets, communities, nft, secret } = input
    let accessSetting: AccessSetting

    // Capture previous access before making changes
    const previousAccess = await getAccessForWorld(worldName)

    switch (type) {
      case AccessType.AllowList: {
        if (communities && communities.length > maxCommunities) {
          throw new InvalidAllowListSettingError(
            `Too many communities. Maximum allowed is ${maxCommunities}, but ${communities.length} were provided.`
          )
        }

        if (wallets && wallets.length > maxWallets) {
          throw new InvalidAllowListSettingError(
            `Too many wallets in allow-list. Maximum allowed is ${maxWallets}, but ${wallets.length} were provided.`
          )
        }

        // Validate that the signer is a member of all communities they're trying to set
        if (communities && communities.length > 0) {
          const { communities: memberCommunities } = await socialService.getMemberCommunities(signer, communities)
          const memberCommunityIds = new Set(memberCommunities.map((c: { id: string }) => c.id))
          const unauthorizedCommunities = communities.filter((id) => !memberCommunityIds.has(id))

          if (unauthorizedCommunities.length > 0) {
            throw new UnauthorizedCommunityError(unauthorizedCommunities)
          }
        }

        accessSetting = {
          type: AccessType.AllowList,
          wallets: wallets || [],
          communities: communities || []
        }
        break
      }
      case AccessType.Unrestricted: {
        accessSetting = { type: AccessType.Unrestricted }
        break
      }
      case AccessType.NFTOwnership: {
        if (!nft) {
          throw new InvalidAccessTypeError('For nft ownership there needs to be a valid nft.')
        }
        accessSetting = { type: AccessType.NFTOwnership, nft }
        break
      }
      case AccessType.SharedSecret: {
        if (!secret) {
          throw new InvalidAccessTypeError('For shared secret there needs to be a valid secret.')
        }
        accessSetting = {
          type: AccessType.SharedSecret,
          secret: bcrypt.hashSync(secret, SALT_ROUNDS)
        }
        break
      }
      default: {
        throw new InvalidAccessTypeError(`Invalid access type: ${type}.`)
      }
    }

    await worldsManager.createBasicWorldIfNotExists(worldName, signer)
    await worldsManager.storeAccess(worldName, accessSetting)
    await accessChangeHandler.handleAccessChange(worldName, previousAccess, accessSetting)

    const timestamp = Date.now()
    const worldSettingsChangedEvent: WorldSettingsChangedEvent = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
      key: `${worldName}-${timestamp}`,
      timestamp,
      metadata: {
        worldName,
        accessType: type
      }
    }
    await snsClient.publishMessage(worldSettingsChangedEvent)
  }

  /**
   * Adds a wallet to the access allow-list for a world.
   * Ensures the world entry exists before modifying permissions.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param owner - The Ethereum address of the world owner
   * @param wallet - The wallet address to add to the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function addWalletToAccessAllowList(worldName: string, owner: EthAddress, wallet: EthAddress): Promise<void> {
    await worldsManager.createBasicWorldIfNotExists(worldName, owner)

    await worldsManager.modifyAccessAtomically(worldName, (access) => {
      if (access.type !== AccessType.AllowList) {
        throw new NotAllowListAccessError(worldName)
      }

      const lowerWallet = wallet.toLowerCase()
      const existingWallets = access.wallets || []

      if (existingWallets.some((w) => w.toLowerCase() === lowerWallet)) {
        return access
      }

      const updatedWallets = [...existingWallets, lowerWallet]
      if (updatedWallets.length > maxWallets) {
        throw new InvalidAllowListSettingError(
          `Cannot add wallet: allow-list would exceed the maximum of ${maxWallets} wallets.`
        )
      }

      return { ...access, wallets: updatedWallets }
    })
  }

  /**
   * Removes a wallet from the access allow-list for a world.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param wallet - The wallet address to remove from the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function removeWalletFromAccessAllowList(worldName: string, wallet: EthAddress): Promise<void> {
    const { previousAccess, updatedAccess } = await worldsManager.modifyAccessAtomically(worldName, (access) => {
      if (access.type !== AccessType.AllowList) {
        throw new NotAllowListAccessError(worldName)
      }

      const lowerWallet = wallet.toLowerCase()
      return { ...access, wallets: (access.wallets || []).filter((w) => w.toLowerCase() !== lowerWallet) }
    })

    await accessChangeHandler.handleAccessChange(worldName, previousAccess, updatedAccess)
  }

  /**
   * Adds a community to the access allow-list for a world.
   * The world must have allow-list access type. The signer must be a member of the community.
   *
   * @param worldName - The name of the world
   * @param signer - The wallet adding the community (must be a member of the community)
   * @param communityId - The community id to add to the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   * @throws {UnauthorizedCommunityError} If the signer is not a member of the community
   */
  async function addCommunityToAccessAllowList(
    worldName: string,
    signer: EthAddress,
    communityId: string
  ): Promise<void> {
    const { communities: memberCommunities } = await socialService.getMemberCommunities(signer, [communityId])
    const isMember = memberCommunities.some((c: { id: string }) => c.id === communityId)
    if (!isMember) {
      throw new UnauthorizedCommunityError([communityId])
    }

    await worldsManager.modifyAccessAtomically(worldName, (access) => {
      if (access.type !== AccessType.AllowList) {
        throw new NotAllowListAccessError(worldName)
      }

      const existingCommunities = access.communities || []
      if (existingCommunities.includes(communityId)) {
        return access
      }

      if (existingCommunities.length >= maxCommunities) {
        throw new InvalidAllowListSettingError(
          `Too many communities. Maximum allowed is ${maxCommunities}, cannot add more.`
        )
      }

      return { ...access, communities: [...existingCommunities, communityId] }
    })
  }

  /**
   * Removes a community from the access allow-list for a world.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param communityId - The community id to remove from the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function removeCommunityFromAccessAllowList(worldName: string, communityId: string): Promise<void> {
    const { previousAccess, updatedAccess } = await worldsManager.modifyAccessAtomically(worldName, (access) => {
      if (access.type !== AccessType.AllowList) {
        throw new NotAllowListAccessError(worldName)
      }

      return { ...access, communities: (access.communities || []).filter((id) => id !== communityId) }
    })

    await accessChangeHandler.handleAccessChange(worldName, previousAccess, updatedAccess)
  }

  return {
    checkAccess,
    setAccess,
    addWalletToAccessAllowList,
    removeWalletFromAccessAllowList,
    addCommunityToAccessAllowList,
    removeCommunityFromAccessAllowList,
    getAccessForWorld
  }
}
