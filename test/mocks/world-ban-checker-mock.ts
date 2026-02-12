import { IWorldBanCheckerComponent } from '../../src/adapters/world-ban-checker'

export const createMockWorldBanChecker = (
  overrides?: Partial<jest.Mocked<IWorldBanCheckerComponent>>
): jest.Mocked<IWorldBanCheckerComponent> => {
  return {
    isUserBannedFromWorld: jest.fn().mockResolvedValue(false),
    ...overrides
  }
}
