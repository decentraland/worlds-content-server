import { SnsClient } from '../../src/types'

export function createSnsClientMock(): SnsClient {
  const publish = jest.fn()
  publish.mockImplementation(() => ({
    MessageId: 'mocked-message-id',
    SequenceNumber: 'mocked-sequence-number',
    $metadata: {}
  }))

  const publishBatch = jest.fn()
  publishBatch.mockImplementation(() => ({
    Successful: [{ Id: 'mocked-id', MessageId: 'mocked-message-id', SequenceNumber: '1' }],
    Failed: [],
    $metadata: {}
  }))

  return {
    publish,
    publishBatch
  }
}
