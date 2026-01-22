import { INameOwnership } from '../../src/types'

export function createMockedNameOwnership(
  overrides?: Partial<jest.Mocked<INameOwnership>>
): jest.Mocked<INameOwnership> {
  return {
    findOwners: jest.fn(),
    ...overrides
  }
}

export function createMockedNameOwnership(
  overrides?: Partial<jest.Mocked<INameOwnership>>
): jest.Mocked<INameOwnership> {
  return {
    findOwners: jest.fn(),
    ...overrides
  }
}
