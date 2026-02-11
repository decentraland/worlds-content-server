import { IQueueConsumerComponent } from '@dcl/queue-consumer-component'

export function createMockQueueConsumer(): jest.Mocked<IQueueConsumerComponent> {
  return {
    addMessageHandler: jest.fn(),
    removeMessageHandler: jest.fn(),
    start: jest.fn(),
    stop: jest.fn()
  }
}
