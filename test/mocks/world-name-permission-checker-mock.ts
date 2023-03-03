import { EthAddress } from '@dcl/schemas'
import { DeploymentToValidate, IWorldNamePermissionChecker } from '../../src/types'

export function createMockNamePermissionChecker(names?: string[]): IWorldNamePermissionChecker {
  const checkPermission = async (_ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    return names && names.map((name) => name.toLowerCase()).includes(worldName.toLowerCase())
  }

  return {
    checkPermission,
    validate(deployment: DeploymentToValidate): Promise<boolean> {
      const sceneJson = JSON.parse(deployment.files.get(deployment.entity.id)!.toString())
      const worldSpecifiedName = sceneJson.metadata.worldConfiguration.name
      return Promise.resolve(
        names && names.map((name) => name.toLowerCase()).includes(worldSpecifiedName.toLowerCase())
      )
    }
  }
}
