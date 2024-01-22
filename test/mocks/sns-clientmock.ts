import { SnsClient } from '../../src/adapters/sns-client'

export function createSnsClientMock(): SnsClient {
  const publish = jest.fn()
  publish.mockImplementation(() => ({
    MessageId: 'mocked-message-id',
    SequenceNumber: 'mocked-sequence-number',
    $metadata: {}
  }))

  const publishBatch = jest.fn()
  publishBatch.mockImplementation(() => ({
    promise: jest.fn().mockResolvedValue({
      Successful: ['mocked-message-id'],
      Failed: []
    })
  }))

  return {
    publish,
    publishBatch
  }
}
