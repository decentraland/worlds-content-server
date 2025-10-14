import { IPublisherComponent } from '@dcl/sns-component'

export function createSnsClientMock(): IPublisherComponent {
  const publishMessage = jest.fn()
  publishMessage.mockImplementation(() => ({
    MessageId: 'mocked-message-id',
    SequenceNumber: 'mocked-sequence-number',
    $metadata: {}
  }))

  const publishMessages = jest.fn()
  publishMessages.mockImplementation(() => ({
    Successful: [{ Id: 'mocked-id', MessageId: 'mocked-message-id', SequenceNumber: '1' }],
    Failed: [],
    $metadata: {}
  }))

  return {
    publishMessage,
    publishMessages
  }
}
