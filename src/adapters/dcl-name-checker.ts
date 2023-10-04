import { AppComponents, IWorldNamePermissionChecker } from '../types'
import { EthAddress } from '@dcl/schemas'

export const createNameChecker = (
  components: Pick<AppComponents, 'logs' | 'nameOwnership'>
): IWorldNamePermissionChecker => {
  const logger = components.logs.getLogger('check-permissions')

  const checkPermission = async (ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    const owner = (await components.nameOwnership.findOwners([worldName])).get(worldName)
    const hasPermission = !!owner && owner.toLowerCase() === ethAddress.toLowerCase()

    logger.debug(`Checking name ${worldName} for address ${ethAddress}: ${hasPermission}`)

    return hasPermission
  }

  return {
    checkPermission
  }
}
