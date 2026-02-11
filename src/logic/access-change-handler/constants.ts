import { AccessType } from '../access/types'
import { AccessChangeAction, type AccessChangeResolver } from './types'
import { secretChanged, allowListUnchanged } from './utils'

/**
 * Explicit transition matrix: for each (previousType, newType) the action to take.
 * Entries may be a direct AccessChangeAction or a resolver (prev, current) => AccessChangeAction
 * for same-type transitions that depend on payload (e.g. SharedSecret secret, AllowList list).
 * Edit this table to change behavior per scenario. Unknown combinations default to kickAll.
 */
export const TRANSITION_MATRIX: Record<AccessType, Record<AccessType, AccessChangeResolver>> = {
  [AccessType.Unrestricted]: {
    [AccessType.Unrestricted]: () => AccessChangeAction.NoKick,
    [AccessType.SharedSecret]: () => AccessChangeAction.KickAll,
    [AccessType.NFTOwnership]: () => AccessChangeAction.KickAll,
    [AccessType.AllowList]: () => AccessChangeAction.KickAll
  },
  [AccessType.SharedSecret]: {
    [AccessType.Unrestricted]: () => AccessChangeAction.KickAll,
    [AccessType.SharedSecret]: (prev, current) =>
      secretChanged(prev, current) ? AccessChangeAction.KickAll : AccessChangeAction.NoKick,
    [AccessType.NFTOwnership]: () => AccessChangeAction.KickAll,
    [AccessType.AllowList]: () => AccessChangeAction.KickAll
  },
  [AccessType.NFTOwnership]: {
    [AccessType.Unrestricted]: () => AccessChangeAction.KickAll,
    [AccessType.SharedSecret]: () => AccessChangeAction.KickAll,
    [AccessType.NFTOwnership]: () => AccessChangeAction.NoKick,
    [AccessType.AllowList]: () => AccessChangeAction.KickAll
  },
  [AccessType.AllowList]: {
    [AccessType.Unrestricted]: () => AccessChangeAction.KickAll,
    [AccessType.SharedSecret]: () => AccessChangeAction.KickAll,
    [AccessType.NFTOwnership]: () => AccessChangeAction.KickAll,
    [AccessType.AllowList]: (prev, current) =>
      allowListUnchanged(prev, current) ? AccessChangeAction.NoKick : AccessChangeAction.KickWithoutAccess
  }
}
