import { IDenyListComponent } from '../../src/logic/denylist/types'

export const createMockDenyList = (
  overrides?: Partial<jest.Mocked<IDenyListComponent>>
): jest.Mocked<IDenyListComponent> => {
  return {
    isDenylisted: jest.fn().mockResolvedValue(false),
    ...overrides
  }
}
