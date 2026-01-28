import { IPermissionsManager } from '../../src/types'

export function createMockedPermissionsManager(
  overrides?: Partial<jest.Mocked<IPermissionsManager>>
): jest.Mocked<IPermissionsManager> {
  return {
    getOwner: jest.fn(),
    getWorldPermissionRecords: jest.fn(),
    grantAddressesWorldWidePermission: jest.fn(),
    removeAddressesPermission: jest.fn(),
    checkParcelsAllowed: jest.fn(),
    getAddressPermissions: jest.fn(),
    addParcelsToPermission: jest.fn(),
    removeParcelsFromPermission: jest.fn(),
    getParcelsForPermission: jest.fn(),
    hasPermissionEntries: jest.fn(),
    ...overrides
  } as jest.Mocked<IPermissionsManager>
}
