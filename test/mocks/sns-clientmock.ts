import { SnsComponent } from '../../src/types'

export function createSnsClientMock(): SnsComponent {
  const publish = jest.fn()
  publish.mockImplementation(() => {
    console.log('publish called')
    return {
      promise: jest.fn().mockResolvedValue({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $response: jest.fn()
      })
    }
  })

  const publishBatch = jest.fn()
  publishBatch.mockImplementation(() => {
    console.log('publishBatch called')
    return {
      promise: jest.fn().mockResolvedValue({
        Successful: [],
        Failed: []
      })
    }
  })

  return {
    publish,
    publishBatch
  }
}
