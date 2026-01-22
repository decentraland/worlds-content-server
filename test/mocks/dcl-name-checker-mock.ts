import { EthAddress } from '@dcl/schemas'
import { IWorldNamePermissionChecker } from '../../src/types'

export function createMockNamePermissionChecker(names?: string[]): IWorldNamePermissionChecker {
  const checkPermission = async (_ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    return !!names && names.map((name) => name.toLowerCase()).includes(worldName.toLowerCase())
  }
  return {
    checkPermission
  }
}

export function createMockedNamePermissionChecker(
  overrides?: Partial<jest.Mocked<IWorldNamePermissionChecker>>
): jest.Mocked<IWorldNamePermissionChecker> {
  return {
    checkPermission: jest.fn(),
    ...overrides
  }
}
