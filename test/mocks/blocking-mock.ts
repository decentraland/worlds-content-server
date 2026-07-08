import { IBlockingComponent } from '../../src/adapters/blocking'

export function createMockBlockingComponent(
  overrides?: Partial<jest.Mocked<IBlockingComponent>>
): jest.Mocked<IBlockingComponent> {
  return {
    blockIfOverQuota: jest.fn().mockResolvedValue(false),
    unblockIfUnderQuota: jest.fn().mockResolvedValue(false),
    collectStaleBlockingRecords: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}
