import { AccessDeniedError, WorldMetadata } from '../types'

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000

export function assertNotBlockedOrWithinInGracePeriod(worldMetadata: WorldMetadata) {
  if (worldMetadata.blockedSince) {
    const since = new Date(worldMetadata.blockedSince)
    const now = new Date()
    if (now.getTime() - since.getTime() > TWO_DAYS) {
      throw new AccessDeniedError(
        `World "${worldMetadata.runtimeMetadata.name}" has been blocked since ${worldMetadata.blockedSince} as it exceeded its allowed storage space.`
      )
    }
  }
}
