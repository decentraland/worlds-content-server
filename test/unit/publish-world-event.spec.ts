import type { IPublisherComponent } from '@dcl/sns-component'
import { Events } from '@dcl/schemas'
import type { WorldUndeploymentEvent } from '@dcl/schemas'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { publishWorldEventWithRetry, WorldEventPublicationError } from '../../src/logic/worlds/publish-world-event'

describe('when publishing a world event with retries', () => {
  let snsClient: jest.Mocked<IPublisherComponent>
  let logger: jest.Mocked<ILoggerComponent.ILogger>
  let event: WorldUndeploymentEvent

  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(Math, 'random').mockReturnValue(0)
    snsClient = {
      publishMessage: jest.fn(),
      publishMessages: jest.fn()
    }
    logger = {
      log: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }
    event = {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLD_UNDEPLOYMENT,
      key: 'example.dcl.eth',
      timestamp: 123,
      metadata: { worldName: 'example.dcl.eth' }
    }
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('and SNS confirms the first publication', () => {
    beforeEach(() => {
      snsClient.publishMessages.mockResolvedValue({
        successfulMessageIds: ['message-id'],
        failedEvents: []
      })
    })

    it('should publish the event once', async () => {
      await publishWorldEventWithRetry(snsClient, logger, event)

      expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
    })
  })

  describe('and SNS reports the first publication as failed', () => {
    let publication: Promise<void>

    beforeEach(async () => {
      snsClient.publishMessages
        .mockResolvedValueOnce({ successfulMessageIds: [], failedEvents: [event] })
        .mockResolvedValueOnce({ successfulMessageIds: ['message-id'], failedEvents: [] })
      publication = publishWorldEventWithRetry(snsClient, logger, event)
      await jest.runAllTimersAsync()
      await publication
    })

    it('should retry the failed event', () => {
      expect(snsClient.publishMessages).toHaveBeenCalledTimes(2)
    })

    it('should log the retry with event context', () => {
      expect(logger.warn).toHaveBeenCalledWith('World event publication failed, retrying', {
        worldName: 'example.dcl.eth',
        eventSubType: Events.SubType.Worlds.WORLD_UNDEPLOYMENT,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100
      })
    })
  })

  describe('and SNS does not confirm the first publication', () => {
    let publication: Promise<void>

    beforeEach(async () => {
      snsClient.publishMessages
        .mockResolvedValueOnce({ successfulMessageIds: [], failedEvents: [] })
        .mockResolvedValueOnce({ successfulMessageIds: ['message-id'], failedEvents: [] })
      publication = publishWorldEventWithRetry(snsClient, logger, event)
      await jest.runAllTimersAsync()
      await publication
    })

    it('should retry the unconfirmed event', () => {
      expect(snsClient.publishMessages).toHaveBeenCalledTimes(2)
    })
  })

  describe('and SNS reports every publication as failed', () => {
    let publicationError: unknown

    beforeEach(async () => {
      snsClient.publishMessages.mockResolvedValue({ successfulMessageIds: [], failedEvents: [event] })
      const publication = publishWorldEventWithRetry(snsClient, logger, event).catch((error: unknown) => error)
      await jest.runAllTimersAsync()
      publicationError = await publication
    })

    it('should attempt publication three times', () => {
      expect(snsClient.publishMessages).toHaveBeenCalledTimes(3)
    })

    it('should reject with a typed publication error', () => {
      expect(publicationError).toBeInstanceOf(WorldEventPublicationError)
    })
  })

  describe('and the publisher throws a transient error', () => {
    let publication: Promise<void>

    beforeEach(async () => {
      snsClient.publishMessages
        .mockRejectedValueOnce(new Error('SNS unavailable'))
        .mockResolvedValueOnce({ successfulMessageIds: ['message-id'], failedEvents: [] })
      publication = publishWorldEventWithRetry(snsClient, logger, event)
      await jest.runAllTimersAsync()
      await publication
    })

    it('should retry the event', () => {
      expect(snsClient.publishMessages).toHaveBeenCalledTimes(2)
    })
  })
})
