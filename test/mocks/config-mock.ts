import { IConfigComponent } from '@well-known-components/interfaces'

export const createMockedConfig = (
  overrides?: jest.Mocked<Partial<IConfigComponent>>
): jest.Mocked<IConfigComponent> => {
  return {
    requireNumber: jest.fn(),
    requireString: jest.fn(),
    getString: jest.fn(),
    getNumber: jest.fn(),
    ...overrides
  }
}
