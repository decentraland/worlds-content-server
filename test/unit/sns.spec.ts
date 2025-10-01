import { snsPublish, snsPublishBatch } from '../../src/logic/sns'
import { SnsClient } from '../../src/types'
import { Events } from '@dcl/schemas'

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

describe('when publishing world events to SNS', () => {
  let arn: string
  let client: SnsClient
  let publish: jest.Mock
  let publishBatch: jest.Mock

  beforeEach(() => {
    arn = 'arn:aws:sns:region:account:topic'
    publish = jest.fn()
    publishBatch = jest.fn()
    client = {} as unknown as SnsClient
    ;(client as any).publish = publish
    ;(client as any).publishBatch = publishBatch
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when publishing deployment with world event metadata', () => {
    let deployment: any
    let sentCommand: any

    beforeEach(async () => {
      deployment = {
        entity: { entityId: 'eid', authChain: [] },
        contentServerUrls: ['http://base'],
        worldEvent: {
          type: Events.Type.WORLD,
          subType: Events.SubType.Worlds.WORLDS_PERMISSION_GRANTED,
          key: 'test-key-1',
          timestamp: Date.now(),
          metadata: {
            title: 'Permission Granted',
            description: 'User granted permission',
            world: 'test-world',
            permissions: ['deploy'],
            url: 'https://test.com',
            address: '0x123'
          }
        }
      }

      publish.mockResolvedValue({ MessageId: 'msg-1', SequenceNumber: '1', $metadata: {} })
      await snsPublish(client, arn, deployment)
      sentCommand = publish.mock.calls[0][0]
    })

    it('should include correct message attributes for deployment', () => {
      expect(sentCommand.input.MessageAttributes.type.StringValue).toBe(Events.Type.WORLD)
      expect(sentCommand.input.MessageAttributes.subType.StringValue).toBe(Events.SubType.Worlds.DEPLOYMENT)
    })

    it('should include priority attribute', () => {
      expect(sentCommand.input.MessageAttributes.priority.StringValue).toBe('1')
    })

    it('should include isMultiplayer=false by default', () => {
      expect(sentCommand.input.MessageAttributes.isMultiplayer.StringValue).toBe('false')
    })

    it('should include the deployment data in the message', () => {
      expect(sentCommand.input.Message).toBe(JSON.stringify(deployment))
    })
  })

  describe('when publishing deployment with isMultiplayer option', () => {
    let deployment: any
    let sentCommand: any

    beforeEach(async () => {
      deployment = {
        entity: { entityId: 'eid', authChain: [] },
        contentServerUrls: ['http://base']
      }

      publish.mockResolvedValue({ MessageId: 'msg-1', SequenceNumber: '1', $metadata: {} })
      await snsPublish(client, arn, deployment, { isMultiplayer: true })
      sentCommand = publish.mock.calls[0][0]
    })

    it('should include isMultiplayer=true in message attributes', () => {
      expect(sentCommand.input.MessageAttributes.isMultiplayer.StringValue).toBe('true')
    })
  })

  describe('when publishing batch deployments', () => {
    let deployments: any[]
    let sentBatchCommand: any
    let result: any

    beforeEach(async () => {
      deployments = [
        {
          entity: { entityId: 'eid1', authChain: [] },
          contentServerUrls: ['http://base1']
        },
        {
          entity: { entityId: 'eid2', authChain: [] },
          contentServerUrls: ['http://base2']
        }
      ]

      publishBatch.mockImplementation((cmd: any) => {
        const entries = cmd.input.PublishBatchRequestEntries
        return Promise.resolve({
          Successful: entries.map((e: any) => ({ Id: e.Id, MessageId: 'm', SequenceNumber: '1' })),
          Failed: [],
          $metadata: {}
        })
      })

      result = await snsPublishBatch(client, arn, deployments)
      sentBatchCommand = publishBatch.mock.calls[0][0]
    })

    it('should include exactly two entries', () => {
      expect(sentBatchCommand.input.PublishBatchRequestEntries).toHaveLength(2)
    })

    it('should include type attribute set to world for all entries', () => {
      const entries: any[] = sentBatchCommand.input.PublishBatchRequestEntries
      expect(entries.every((e) => e.MessageAttributes.type.StringValue === Events.Type.WORLD)).toBe(true)
    })

    it('should include subType attribute set to deployment for all entries', () => {
      const entries: any[] = sentBatchCommand.input.PublishBatchRequestEntries
      expect(entries.every((e) => e.MessageAttributes.subType.StringValue === Events.SubType.Worlds.DEPLOYMENT)).toBe(
        true
      )
    })

    it('should use entityId as the entry ID', () => {
      const entries: any[] = sentBatchCommand.input.PublishBatchRequestEntries
      expect(entries[0].Id).toBe('eid1')
      expect(entries[1].Id).toBe('eid2')
    })

    it('should aggregate all entries as Successful with no failures', () => {
      expect(result.Successful?.length).toBe(2)
    })
  })
})
