import { ILoggerComponent } from '@well-known-components/interfaces'

export function createMockLogs(overrides?: Partial<jest.Mocked<ILoggerComponent>>): jest.Mocked<ILoggerComponent> {
  return {
    getLogger: jest.fn().mockReturnValue({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn()
    }),
    ...overrides
  }
}
