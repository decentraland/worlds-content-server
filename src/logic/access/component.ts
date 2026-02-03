import { AppComponents } from '../../types'
import { AccessInput, AccessSetting, AccessType, IAccessComponent } from './types'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { defaultAccess, MAX_COMMUNITIES } from './constants'
import { InvalidAccessTypeError, NotAllowListAccessError, UnauthorizedCommunityError } from './errors'
import { ISocialServiceComponent } from '../../adapters/social-service'

const saltRounds = 10

type CheckingFunction = (ethAddress: EthAddress, extras?: any) => Promise<boolean>

function createUnrestrictedChecker(): CheckingFunction {
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

/**
 * Creates an allow-list checker factory that captures the socialService dependency.
 * This avoids passing socialService through multiple layers.
 */
function createAllowListCheckerFactory(socialService: ISocialServiceComponent) {
  return (allowList: string[], communities: string[]): CheckingFunction => {
    const lowerCasedAllowList = allowList.map((ethAddress) => ethAddress.toLowerCase())

    return async (ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
      // Check wallets first (faster, local)
      if (lowerCasedAllowList.includes(ethAddress.toLowerCase())) {
        return true
      }

      // Check communities if defined (batch check)
      if (communities.length > 0) {
        const { communities: memberCommunities } = await socialService.getMemberCommunities(ethAddress, communities)
        return memberCommunities.length > 0
      }

      return false
    }
  }
}

export function createAccessComponent({
  socialService,
  worldsManager
}: Pick<AppComponents, 'socialService' | 'worldsManager'>): IAccessComponent {
  const createAllowListChecker = createAllowListCheckerFactory(socialService)

  function createAccessCheckerFrom(accessSetting: AccessSetting): CheckingFunction {
    switch (accessSetting.type) {
      case AccessType.Unrestricted:
        return createUnrestrictedChecker()
      case AccessType.SharedSecret:
        return createSharedSecretChecker(accessSetting.secret)
      case AccessType.NFTOwnership:
        return createNftOwnershipChecker(accessSetting.nft)
      case AccessType.AllowList:
        return createAllowListChecker(accessSetting.wallets, accessSetting.communities)
      default:
        throw new Error(`Invalid access type.`)
    }
  }

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

  async function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    const access = await getAccessForWorld(worldName)

    const accessChecker = createAccessCheckerFrom(access)
    return accessChecker(ethAddress, extras)
  }

  /**
   * Set access settings for a world with validation.
   * Validates the access type and constructs the appropriate AccessSetting.
   * For AllowList with communities, validates that the signer is a member of all communities.
   */
  async function setAccess(worldName: string, signer: EthAddress, input: AccessInput): Promise<void> {
    const { type, wallets, communities, nft, secret } = input
    let accessSetting: AccessSetting

    switch (type) {
      case AccessType.AllowList: {
        if (communities && communities.length > MAX_COMMUNITIES) {
          throw new InvalidAccessTypeError(
            `Too many communities. Maximum allowed is ${MAX_COMMUNITIES}, but ${communities.length} were provided.`
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
          secret: bcrypt.hashSync(secret, saltRounds)
        }
        break
      }
      default: {
        throw new InvalidAccessTypeError(`Invalid access type: ${type}.`)
      }
    }

    await worldsManager.storeAccess(worldName, accessSetting)
  }

  /**
   * Adds a wallet to the access allow-list for a world.
   * The world must have allow-list access type for this operation to succeed.
   *
   * @param worldName - The name of the world
   * @param wallet - The wallet address to add to the allow-list
   * @throws {NotAllowListAccessError} If the world does not have allow-list access type
   */
  async function addWalletToAccessAllowList(worldName: string, wallet: EthAddress): Promise<void> {
    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const lowerWallet = wallet.toLowerCase()
    const existingWallets = access.wallets || []

    // Check if wallet is already in the list (case-insensitive)
    if (existingWallets.some((w) => w.toLowerCase() === lowerWallet)) {
      return // Already in the list, idempotent operation
    }

    const updatedAccess: AccessSetting = {
      ...access,
      wallets: [...existingWallets, lowerWallet]
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
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
    const access = await getAccessForWorld(worldName)

    if (access.type !== AccessType.AllowList) {
      throw new NotAllowListAccessError(worldName)
    }

    const lowerWallet = wallet.toLowerCase()
    const existingWallets = access.wallets || []

    // Filter out the wallet (case-insensitive)
    const updatedWallets = existingWallets.filter((w) => w.toLowerCase() !== lowerWallet)

    const updatedAccess: AccessSetting = {
      ...access,
      wallets: updatedWallets
    }

    await worldsManager.storeAccess(worldName, updatedAccess)
  }

  return {
    checkAccess,
    setAccess,
    addWalletToAccessAllowList,
    removeWalletFromAccessAllowList,
    getAccessForWorld
  }
}
