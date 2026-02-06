import { EthAddress } from '@dcl/schemas'

export enum AccessType {
  Unrestricted = 'unrestricted',
  SharedSecret = 'shared-secret',
  NFTOwnership = 'nft-ownership',
  AllowList = 'allow-list'
}

export type UnrestrictedAccessSetting = {
  type: AccessType.Unrestricted
}

export type SharedSecretAccessSetting = {
  type: AccessType.SharedSecret
  secret: string
}

export type NftOwnershipAccessSetting = {
  type: AccessType.NFTOwnership
  nft: string
}

export type AllowListAccessSetting = {
  type: AccessType.AllowList
  wallets: string[]
  communities: string[]
}

export type AccessSetting =
  | UnrestrictedAccessSetting
  | SharedSecretAccessSetting
  | NftOwnershipAccessSetting
  | AllowListAccessSetting

export type AccessInput = {
  type: string
  wallets?: string[]
  communities?: string[]
  nft?: string
  secret?: string
}

export type IAccessComponent = {
  checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean>
  setAccess(worldName: string, signer: EthAddress, input: AccessInput): Promise<void>
  addWalletToAccessAllowList(worldName: string, owner: EthAddress, wallet: EthAddress): Promise<void>
  removeWalletFromAccessAllowList(worldName: string, wallet: EthAddress): Promise<void>
  getAccessForWorld(worldName: string): Promise<AccessSetting>
}
