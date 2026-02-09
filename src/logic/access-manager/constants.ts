import { AccessType } from '../access/types'
import { AccessChangeAction } from './types'

/**
 * Explicit transition matrix: for each (previousType, newType) the action to take.
 * Edit this table to change behavior per scenario. Unknown combinations default to kickAll.
 */
export const TRANSITION_MATRIX: Record<AccessType, Record<AccessType, AccessChangeAction>> = {
  [AccessType.Unrestricted]: {
    [AccessType.Unrestricted]: 'noKick',
    [AccessType.SharedSecret]: 'kickAll',
    [AccessType.NFTOwnership]: 'kickAll',
    [AccessType.AllowList]: 'kickAll'
  },
  [AccessType.SharedSecret]: {
    [AccessType.Unrestricted]: 'kickAll',
    [AccessType.SharedSecret]: 'noKick',
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
    [AccessType.AllowList]: 'noKick'
  }
}
