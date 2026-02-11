import { AccessSetting, AccessType, AllowListAccessSetting } from '../access/types'
import { defaultAccess } from '../access/constants'
import { EthAddress } from '@dcl/schemas'
import bcrypt from 'bcrypt'
import { ISocialServiceComponent } from '../../adapters/social-service'
import { IWorldsManager } from '../../types'
import { IAccessCheckerComponent } from './types'

export async function createAccessCheckerComponent({
  worldsManager,
  socialService
}: {
  worldsManager: IWorldsManager
  socialService: ISocialServiceComponent
}): Promise<IAccessCheckerComponent> {
  async function checkAllowList(access: AllowListAccessSetting, ethAddress: EthAddress): Promise<boolean> {
    const lowerCasedAllowList = access.wallets?.map((wallet) => wallet.toLowerCase()) ?? []

    if (lowerCasedAllowList.includes(ethAddress.toLowerCase())) {
      return true
    }

    if (access.communities && access.communities.length > 0) {
      const { communities: memberCommunities } = await socialService.getMemberCommunities(
        ethAddress,
        access.communities
      )
      return memberCommunities.length > 0
    }

    return false
  }

  async function getWorldAccess(worldName: string): Promise<AccessSetting> {
    const { records } = await worldsManager.getRawWorldRecords({ worldName })
    if (records.length === 0) {
      return defaultAccess()
    }
    return records[0].access || defaultAccess()
  }

  async function checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean> {
    const access = await getWorldAccess(worldName)

    switch (access.type) {
      case AccessType.Unrestricted:
        return true
      case AccessType.SharedSecret:
        return bcrypt.compare(extras, access.secret) // extras being the secret provided by the user
      case AccessType.NFTOwnership:
        // TODO: Check NFT ownership in the blockchain
        return false
      case AccessType.AllowList:
        return checkAllowList(access, ethAddress)
      default:
        throw new Error('Invalid access type.')
    }
  }

  return { checkAccess, getWorldAccess }
}
