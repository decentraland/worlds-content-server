import { IPermissionChecker } from '../../src/types'

export function createMockedPermissionsChecker(
  overrides?: Partial<jest.Mocked<IPermissionChecker>>
): jest.Mocked<IPermissionChecker> {
  return {
    checkPermission: jest.fn(),
    ...overrides
  }
}
