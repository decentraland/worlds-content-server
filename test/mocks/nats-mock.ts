import { INatsComponent } from '@well-known-components/nats-component/dist/types'

export function createMockNatsComponent(): jest.Mocked<INatsComponent> {
  return {
    publish: jest.fn(),
    subscribe: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    events: {
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      all: undefined
    }
  }
}
