import { AccessSetting, AccessType } from './types'

const _defaultAccess: AccessSetting = {
  type: AccessType.Unrestricted
}

export function defaultAccess(): AccessSetting {
  return JSON.parse(JSON.stringify(_defaultAccess))
}
