import { TWO_DAYS_IN_MS, WorldMetadata } from '../types'
import { NotAuthorizedError } from '@dcl/platform-server-commons'

export function assertNotBlockedOrWithinInGracePeriod(worldMetadata: WorldMetadata) {
  if (worldMetadata.blockedSince) {
    const now = new Date()
    if (now.getTime() - worldMetadata.blockedSince.getTime() > TWO_DAYS_IN_MS) {
      throw new NotAuthorizedError(
        `World "${worldMetadata.runtimeMetadata.name}" has been blocked since ${worldMetadata.blockedSince} as it exceeded its allowed storage space.`
      )
    }
  }
}
