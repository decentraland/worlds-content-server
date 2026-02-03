import { AccessSetting, AccessType } from './types'

const _defaultAccess: AccessSetting = {
  type: AccessType.Unrestricted
}

export const MAX_COMMUNITIES = 50

export function defaultAccess(): AccessSetting {
  return JSON.parse(JSON.stringify(_defaultAccess))
}
