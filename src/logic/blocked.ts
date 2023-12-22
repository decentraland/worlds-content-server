import { WorldMetadata } from '../types'
import { NotAuthorizedError } from '@dcl/platform-server-commons'

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000

export function assertNotBlockedOrWithinInGracePeriod(worldMetadata: WorldMetadata) {
  if (worldMetadata.blockedSince) {
    const now = new Date()
    if (now.getTime() - worldMetadata.blockedSince.getTime() > TWO_DAYS) {
      throw new NotAuthorizedError(
        `World "${worldMetadata.runtimeMetadata.name}" has been blocked since ${worldMetadata.blockedSince} as it exceeded its allowed storage space.`
      )
    }
  }
}
