import { IWhitelistComponent } from '../../src/adapters/whitelist'
import { Whitelist } from '../../src/types'

export function createMockWhitelistComponent(whitelist: Whitelist = {}): jest.Mocked<IWhitelistComponent> {
  return {
    get: jest.fn().mockResolvedValue(whitelist)
  }
}
