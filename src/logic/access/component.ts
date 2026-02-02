import { AppComponents } from '../../types'
import { AccessInput, AccessSetting, AccessType, AddressAccessInfo, IAccessComponent } from './types'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { defaultAccess, MAX_COMMUNITIES } from './constants'
import { InvalidAccessTypeError } from './errors'

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

function createAllowListChecker(allowList: string[]): CheckingFunction {
  const lowerCasedAllowList = allowList.map((ethAddress) => ethAddress.toLowerCase())
  return (ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
    return Promise.resolve(lowerCasedAllowList.includes(ethAddress.toLowerCase()))
  }
}

function createAccessCheckerFrom(accessSetting: AccessSetting): CheckingFunction {
  switch (accessSetting.type) {
    case AccessType.Unrestricted:
      return createUnrestrictedChecker()
    case AccessType.SharedSecret:
      return createSharedSecretChecker(accessSetting.secret)
    case AccessType.NFTOwnership:
      return createNftOwnershipChecker(accessSetting.nft)
    case AccessType.AllowList:
      return createAllowListChecker(accessSetting.wallets)
    default:
      throw new Error(`Invalid access type.`)
  }
}

export function createAccessComponent({ worldsManager }: Pick<AppComponents, 'worldsManager'>): IAccessComponent {
  async function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    const access = metadata?.access || defaultAccess()

    const accessChecker = createAccessCheckerFrom(access)
    return accessChecker(ethAddress, extras)
  }

  /**
   * Set access settings for a world with validation.
   * Validates the access type and constructs the appropriate AccessSetting.
   */
  async function setAccess(worldName: string, input: AccessInput): Promise<void> {
    const { type, wallets, communities, nft, secret } = input
    let accessSetting: AccessSetting

    switch (type) {
      case AccessType.AllowList: {
        if (communities && communities.length > MAX_COMMUNITIES) {
          throw new InvalidAccessTypeError(
            `Too many communities. Maximum allowed is ${MAX_COMMUNITIES}, but ${communities.length} were provided.`
          )
        }
        accessSetting = {
          type: AccessType.AllowList,
          wallets: wallets || [],
          ...(communities?.length ? { communities } : {})
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
   * Get access permission info for a specific address.
   * Returns the address info if the world has allow-list access and the address is in the list.
   * Returns null if access is not allow-list type or the address is not in the list.
   */
  async function getAddressAccessPermission(worldName: string, address: EthAddress): Promise<AddressAccessInfo | null> {
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    const access = metadata?.access

    if (!access || access.type !== AccessType.AllowList) {
      return null
    }

    const lowerAddress = address.toLowerCase()
    const isInAllowList = access.wallets?.some((w) => w.toLowerCase() === lowerAddress)

    if (!isInAllowList) {
      return null
    }

    return {
      worldName,
      address: lowerAddress
    }
  }

  return {
    checkAccess,
    setAccess,
    getAddressAccessPermission
  }
}
