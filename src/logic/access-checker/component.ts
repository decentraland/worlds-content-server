import { AccessSetting, AccessType } from '../access/types'
import { defaultAccess } from '../access/constants'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { ISocialServiceComponent } from '../../adapters/social-service'
import { IWorldsManager } from '../../types'
import { IAccessCheckerComponent } from './types'

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

function createAllowListCheckerFactory(socialService: ISocialServiceComponent) {
  return (allowList: string[], communities: string[]): CheckingFunction => {
    const lowerCasedAllowList = allowList.map((ethAddress) => ethAddress.toLowerCase())

    return async (ethAddress: EthAddress, _extras?: any): Promise<boolean> => {
      if (lowerCasedAllowList.includes(ethAddress.toLowerCase())) {
        return true
      }
      if (communities.length > 0) {
        const { communities: memberCommunities } = await socialService.getMemberCommunities(ethAddress, communities)
        return memberCommunities.length > 0
      }
      return false
    }
  }
}

export async function createAccessCheckerComponent({
  worldsManager,
  socialService
}: {
  worldsManager: IWorldsManager
  socialService: ISocialServiceComponent
}): Promise<IAccessCheckerComponent> {
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

  async function getAccessForWorld(worldName: string): Promise<AccessSetting> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })
    if (records.length === 0) {
      return defaultAccess()
    }
    return records[0].access || defaultAccess()
  }

  async function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    const access = await getAccessForWorld(worldName)
    const checker = createAccessCheckerFrom(access)
    return checker(ethAddress, extras)
  }

  return { checkAccess }
}
