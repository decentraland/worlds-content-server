import { IBansComponent } from '../../src/adapters/bans-adapter'

export const createMockBans = (overrides?: Partial<jest.Mocked<IBansComponent>>): jest.Mocked<IBansComponent> => {
  return {
    isUserBannedFromScene: jest.fn().mockResolvedValue(false),
    ...overrides
  }
}
