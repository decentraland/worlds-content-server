import { IPermissionsComponent } from '../../src/logic/permissions'

export function createMockedPermissionsComponent(
  overrides?: Partial<jest.Mocked<IPermissionsComponent>>
): jest.Mocked<IPermissionsComponent> {
  return {
    hasPermissionForParcels: jest.fn().mockResolvedValue(false),
    hasWorldWidePermission: jest.fn().mockResolvedValue(false),
    grantWorldWidePermission: jest.fn().mockResolvedValue(undefined),
    revokePermission: jest.fn().mockResolvedValue(undefined),
    setDeploymentPermission: jest.fn().mockResolvedValue(undefined),
    setStreamingPermission: jest.fn().mockResolvedValue(undefined),
    addParcelsToPermission: jest.fn().mockResolvedValue(undefined),
    removeParcelsFromPermission: jest.fn().mockResolvedValue(undefined),
    getAllowedParcelsForPermission: jest.fn().mockResolvedValue({ total: 0, results: [] }),
    getAddressesForParcelPermission: jest.fn().mockResolvedValue({ total: 0, results: [] }),
    getPermissionsSummary: jest.fn().mockResolvedValue({}),
    ...overrides
  }
}
