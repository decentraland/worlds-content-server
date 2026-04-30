import { IDenyListComponent } from '../../src/logic/denylist/types'

export const createMockDenyList = (
  overrides?: Partial<jest.Mocked<IDenyListComponent>>
): jest.Mocked<IDenyListComponent> => {
  return {
    isWalletDenylisted: jest.fn().mockResolvedValue(false),
    isEntityDenylisted: jest.fn().mockResolvedValue(false),
    ...overrides
  }
}
