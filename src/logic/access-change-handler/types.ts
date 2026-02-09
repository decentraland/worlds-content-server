import type { AccessSetting } from '../access/types'

/** Action to take when access type changes from one value to another. */
export type AccessChangeAction = 'noKick' | 'kickAll' | 'kickWithoutAccess'

/** Resolver: same-type transitions that depend on previous/new settings (e.g. secret or allow-list diff). */
export type AccessChangeResolver = (previousAccess: AccessSetting, newAccess: AccessSetting) => AccessChangeAction

/**
 * Access change handler: reacts to access settings changes. Always call
 * handleAccessChange; the handler selects the reaction from the transition
 * matrix (with runtime overrides for AllowList list changes and SharedSecret
 * secret change) and applies it. Requires accessChecker when the reaction
 * is kickWithoutAccess (AllowList list change).
 */
export interface IAccessChangeHandler {
  handleAccessChange(worldName: string, previousAccess: AccessSetting, newAccess: AccessSetting): Promise<void>
}
