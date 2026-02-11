import type { AccessSetting } from '../access/types'

export enum AccessChangeAction {
  NoKick = 'noKick',
  KickAllParticipants = 'kickAllParticipants',
  KickParticipantsWithoutAccess = 'kickParticipantsWithoutAccess'
}

export interface IAccessChangeHandler {
  handleAccessChange(worldName: string, previousAccess: AccessSetting, newAccess: AccessSetting): Promise<void>
}
