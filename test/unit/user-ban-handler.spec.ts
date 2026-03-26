import { createUserBanHandler, IUserBanHandler } from '../../src/controllers/handlers/user-ban-handler'
import { Events, UserBanCreatedEvent } from '@dcl/schemas'
import { IPeersRegistry } from '../../src/types'
import { IParticipantKicker } from '../../src/logic/participant-kicker'
import { createMockParticipantKicker } from '../mocks/participant-kicker-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { createMockLogs } from '../mocks/logs-mock'

function createUserBanCreatedEvent(bannedAddress: string): UserBanCreatedEvent {
  return {
    type: Events.Type.MODERATION,
    subType: Events.SubType.Moderation.USER_BAN_CREATED,
    key: `user-ban-created-${bannedAddress}`,
    timestamp: Date.now(),
    metadata: {
      id: 'ban-1',
      bannedAddress,
      bannedBy: '0xModerator',
      reason: 'Violation of terms',
      bannedAt: Date.now(),
      expiresAt: null
    }
  }
}

describe('UserBanHandler', () => {
  let handler: IUserBanHandler
  let mockPeersRegistry: jest.Mocked<IPeersRegistry>
  let mockParticipantKicker: jest.Mocked<IParticipantKicker>

  beforeEach(() => {
    mockPeersRegistry = createMockPeersRegistry()
    mockParticipantKicker = createMockParticipantKicker()

    handler = createUserBanHandler({
      peersRegistry: mockPeersRegistry,
      participantKicker: mockParticipantKicker,
      logs: createMockLogs()
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the banned user is not connected to any world', () => {
    let event: UserBanCreatedEvent

    beforeEach(() => {
      event = createUserBanCreatedEvent('0xBanned')
      mockPeersRegistry.getPeerWorld.mockReturnValueOnce(undefined)
    })

    it('should check if the user is connected to a world', async () => {
      await handler.handle(event)

      expect(mockPeersRegistry.getPeerWorld).toHaveBeenCalledWith('0xBanned')
    })

    it('should not call kickParticipant', async () => {
      await handler.handle(event)

      expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
    })
  })

  describe('when the banned user is connected to a world', () => {
    let event: UserBanCreatedEvent

    beforeEach(() => {
      event = createUserBanCreatedEvent('0xBanned')
      mockPeersRegistry.getPeerWorld.mockReturnValueOnce('world-1')
    })

    it('should check if the user is connected to a world', async () => {
      await handler.handle(event)

      expect(mockPeersRegistry.getPeerWorld).toHaveBeenCalledWith('0xBanned')
    })

    it('should kick the user from their world', async () => {
      await handler.handle(event)

      expect(mockParticipantKicker.kickParticipant).toHaveBeenCalledWith('world-1', '0xBanned')
    })
  })

  describe('when kickParticipant throws', () => {
    let event: UserBanCreatedEvent

    beforeEach(() => {
      event = createUserBanCreatedEvent('0xBanned')
      mockPeersRegistry.getPeerWorld.mockReturnValueOnce('world-1')
      mockParticipantKicker.kickParticipant.mockRejectedValueOnce(new Error('kick failed'))
    })

    it('should resolve without throwing', async () => {
      await expect(handler.handle(event)).resolves.toBeUndefined()
    })
  })
})
