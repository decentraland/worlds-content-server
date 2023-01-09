import { EthAddress } from '@dcl/schemas'
import { IDclNameChecker } from '../../src/types'

export function createMockDclNameChecker(names?: string[]): IDclNameChecker {
  const checkPermission = async (_ethAddress: EthAddress, dclName: string): Promise<boolean> =>
    names && dclName.length > 0 && names.map((name) => name.toLowerCase()).includes(dclName.toLowerCase())
  return {
    checkPermission
  }
}
