import { IBansComponent } from '../../src/adapters/bans'

export const createMockBans = (overrides?: Partial<jest.Mocked<IBansComponent>>): jest.Mocked<IBansComponent> => {
  return {
    isUserBannedFromScene: jest.fn().mockResolvedValue(false),
    isPlayerBanned: jest.fn().mockResolvedValue(false),
    recordPlayerConnection: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}
