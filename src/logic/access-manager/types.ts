import type { AccessSetting } from '../access/types'

/** Action to take when access type changes from one value to another. */
export type AccessChangeAction = 'noKick' | 'kickAll'

/**
 * Access change handler: reacts to access settings changes (e.g. kicks
 * participants when switching to a more restrictive type). Selects the
 * reaction from the transition matrix, fetches participants, and applies it.
 */
export interface IAccessChangeHandler {
  handleAccessChange(worldName: string, previousAccess: AccessSetting, newAccess: AccessSetting): Promise<void>
}
