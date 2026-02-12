import { IAccessComponent } from '../../src/logic/access/types'

export const createMockAccess = (overrides?: Partial<jest.Mocked<IAccessComponent>>): jest.Mocked<IAccessComponent> => {
  return {
    checkAccess: jest.fn(),
    setAccess: jest.fn(),
    addWalletToAccessAllowList: jest.fn(),
    removeWalletFromAccessAllowList: jest.fn(),
    addCommunityToAccessAllowList: jest.fn(),
    removeCommunityFromAccessAllowList: jest.fn(),
    getAccessForWorld: jest.fn(),
    ...overrides
  }
}
