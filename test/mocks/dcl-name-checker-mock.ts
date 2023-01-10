import { EthAddress } from '@dcl/schemas'
import { IDclNameChecker } from '../../src/types'

export function createMockDclNameChecker(names?: string[]): IDclNameChecker {
  const checkPermission = async (_ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    return names && names.map((name) => name.toLowerCase()).includes(worldName.toLowerCase())
  }
  return {
    checkPermission
  }
}
