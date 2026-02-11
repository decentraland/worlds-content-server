import { AccessType } from '../../src/logic/access/types'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'

const defaultAllowListAccess = {
  type: AccessType.AllowList,
  wallets: [] as string[],
  communities: [] as string[]
}

export function createMockAccessChecker(
  overrides?: Partial<jest.Mocked<IAccessCheckerComponent>>
): jest.Mocked<IAccessCheckerComponent> {
  return {
    checkAccess: jest.fn().mockResolvedValue(false),
    getWorldAccess: jest.fn().mockResolvedValue(defaultAllowListAccess),
    ...overrides
  }
}
