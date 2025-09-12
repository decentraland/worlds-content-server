import { snsPublish, snsPublishBatch } from '../../src/logic/sns'
import { SnsClient } from '../../src/types'

describe('when publishing deployments to SNS', () => {
  let arn: string
  let deployment: any
  let client: SnsClient
  let publish: jest.Mock
  let publishBatch: jest.Mock

  beforeEach(() => {
    arn = 'arn:aws:sns:region:account:topic'
    deployment = {
      entity: { entityId: 'eid', authChain: [] },
      contentServerUrls: ['http://base']
    }

    publish = jest.fn()
    publishBatch = jest.fn()
    client = {} as unknown as SnsClient
    ;(client as any).publish = publish
    ;(client as any).publishBatch = publishBatch
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when calling snsPublish', () => {
    describe('and isMultiplayer option is true', () => {
      let sentCommand: any

      beforeEach(async () => {
        publish.mockResolvedValue({ MessageId: 'm', SequenceNumber: '1', $metadata: {} })
        await snsPublish(client, arn, deployment, { isMultiplayer: true })
        sentCommand = publish.mock.calls[0][0]
      })

      it('should include isMultiplayer=true in the message attributes', () => {
        expect(sentCommand.input.MessageAttributes.isMultiplayer.StringValue).toBe('true')
      })
    })

    describe('and isMultiplayer option is omitted', () => {
      let sentCommand: any

      beforeEach(async () => {
        publish.mockResolvedValue({ MessageId: 'm', SequenceNumber: '1', $metadata: {} })
        await snsPublish(client, arn, deployment)
        sentCommand = publish.mock.calls[0][0]
      })

      it('should include isMultiplayer=false in the message attributes', () => {
        expect(sentCommand.input.MessageAttributes.isMultiplayer.StringValue).toBe('false')
      })
    })
  })

  describe('when calling snsPublishBatch', () => {
    let sentBatchCommand: any
    let result: any

    beforeEach(async () => {
      publishBatch.mockImplementation((cmd: any) => {
        const entries = cmd.input.PublishBatchRequestEntries
        return Promise.resolve({
          Successful: entries.map((e: any) => ({ Id: e.Id, MessageId: 'm', SequenceNumber: '1' })),
          Failed: [],
          $metadata: {}
        })
      })

      result = await snsPublishBatch(client, arn, [
        deployment,
        { ...deployment, entity: { entityId: 'eid2', authChain: [] } }
      ])
      sentBatchCommand = publishBatch.mock.calls[0][0]
    })

    it('should include exactly two entries', () => {
      expect(sentBatchCommand.input.PublishBatchRequestEntries).toHaveLength(2)
    })

    it('should include type attribute set to world for all entries', () => {
      const entries: any[] = sentBatchCommand.input.PublishBatchRequestEntries
      expect(entries.every((e) => e.MessageAttributes.type.StringValue === 'world')).toBe(true)
    })

    it('should include subType attribute set to deployment for all entries', () => {
      const entries: any[] = sentBatchCommand.input.PublishBatchRequestEntries
      expect(entries.every((e) => e.MessageAttributes.subType.StringValue === 'deployment')).toBe(true)
    })

    it('should aggregate all entries as Successful with no failures', () => {
      expect(result.Successful?.length).toBe(2)
    })
  })
})
