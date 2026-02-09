import { AccessType } from '../access/types'
import { AccessChangeAction, type AccessChangeResolver } from './types'
import { secretChanged, allowListUnchanged } from './utils'

export type AccessChangeMatrixEntry = AccessChangeAction | AccessChangeResolver

/**
 * Explicit transition matrix: for each (previousType, newType) the action to take.
 * Entries may be a direct AccessChangeAction or a resolver (prev, current) => AccessChangeAction
 * for same-type transitions that depend on payload (e.g. SharedSecret secret, AllowList list).
 * Edit this table to change behavior per scenario. Unknown combinations default to kickAll.
 */
export const TRANSITION_MATRIX: Record<AccessType, Record<AccessType, AccessChangeMatrixEntry>> = {
  [AccessType.Unrestricted]: {
    [AccessType.Unrestricted]: 'noKick',
    [AccessType.SharedSecret]: 'kickAll',
    [AccessType.NFTOwnership]: 'kickAll',
    [AccessType.AllowList]: 'kickAll'
  },
  [AccessType.SharedSecret]: {
    [AccessType.Unrestricted]: 'kickAll',
    [AccessType.SharedSecret]: (prev, current) => (secretChanged(prev, current) ? 'kickAll' : 'noKick'),
    [AccessType.NFTOwnership]: 'kickAll',
    [AccessType.AllowList]: 'kickAll'
  },
  [AccessType.NFTOwnership]: {
    [AccessType.Unrestricted]: 'kickAll',
    [AccessType.SharedSecret]: 'kickAll',
    [AccessType.NFTOwnership]: 'noKick',
    [AccessType.AllowList]: 'kickAll'
  },
  [AccessType.AllowList]: {
    [AccessType.Unrestricted]: 'kickAll',
    [AccessType.SharedSecret]: 'kickAll',
    [AccessType.NFTOwnership]: 'kickAll',
    [AccessType.AllowList]: (prev, current) => (allowListUnchanged(prev, current) ? 'noKick' : 'kickWithoutAccess')
  }
}
