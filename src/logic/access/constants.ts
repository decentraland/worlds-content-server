import { AccessSetting, AccessType } from './types'

const _defaultAccess: AccessSetting = {
  type: AccessType.Unrestricted
}

export function defaultAccess(): AccessSetting {
  return JSON.parse(JSON.stringify(_defaultAccess))
}

export const DEFAULT_MAX_COMMUNITIES = 50

export const DEFAULT_MAX_WALLETS = 1000

export const SALT_ROUNDS = 10
