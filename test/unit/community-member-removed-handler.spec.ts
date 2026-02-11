import {
  createCommunityMemberRemovedHandler,
  ICommunityMemberRemovedHandler
} from '../../src/controllers/handlers/community-member-removed-handler'
import { Events, CommunityMemberRemovedEvent, CommunityMemberBannedEvent, CommunityMemberLeftEvent } from '@dcl/schemas'
import { IPeersRegistry } from '../../src/types'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'
import { IParticipantKicker } from '../../src/logic/participant-kicker'
import { AccessType } from '../../src/logic/access/types'
import { createMockParticipantKicker } from '../mocks/participant-kicker-mock'
import { createMockAccessChecker } from '../mocks/access-checker-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { createMockLogs } from '../mocks/logs-mock'

function createMemberRemovedEvent(communityId: string, memberAddress: string): CommunityMemberRemovedEvent {
  return {
    type: Events.Type.COMMUNITY,
    subType: Events.SubType.Community.MEMBER_REMOVED,
    key: `community-member-removed-${communityId}-${memberAddress}`,
    timestamp: Date.now(),
    metadata: {
      id: communityId,
      name: 'Test Community',
      memberAddress,
      thumbnailUrl: 'https://example.com/thumb.png'
    }
  }
}

function createMemberBannedEvent(communityId: string, memberAddress: string): CommunityMemberBannedEvent {
  return {
    type: Events.Type.COMMUNITY,
    subType: Events.SubType.Community.MEMBER_BANNED,
    key: `community-member-banned-${communityId}-${memberAddress}`,
    timestamp: Date.now(),
    metadata: {
      id: communityId,
      name: 'Test Community',
      memberAddress,
      thumbnailUrl: 'https://example.com/thumb.png'
    }
  }
}

function createMemberLeftEvent(communityId: string, memberAddress: string): CommunityMemberLeftEvent {
  return {
    type: Events.Type.COMMUNITY,
    subType: Events.SubType.Community.MEMBER_LEFT,
    key: `community-member-left-${communityId}-${memberAddress}`,
    timestamp: Date.now(),
    metadata: {
      id: communityId,
      memberAddress
    }
  }
}

describe('CommunityMemberRemovedHandler', () => {
  let handler: ICommunityMemberRemovedHandler
  let mockPeersRegistry: jest.Mocked<IPeersRegistry>
  let mockAccessChecker: jest.Mocked<IAccessCheckerComponent>
  let mockParticipantKicker: jest.Mocked<IParticipantKicker>

  beforeEach(() => {
    mockPeersRegistry = createMockPeersRegistry()
    mockAccessChecker = createMockAccessChecker()
    mockParticipantKicker = createMockParticipantKicker()

    handler = createCommunityMemberRemovedHandler({
      peersRegistry: mockPeersRegistry,
      accessChecker: mockAccessChecker,
      participantKicker: mockParticipantKicker,
      logs: createMockLogs()
    })
  })

  describe('when the member is not connected to any world', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeerWorld.mockReturnValue(undefined)
    })

    it('should not get world access, check access or kick anyone', async () => {
      await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

      expect(mockPeersRegistry.getPeerWorld).toHaveBeenCalledWith('0xAlice')
      expect(mockAccessChecker.getWorldAccess).not.toHaveBeenCalled()
      expect(mockAccessChecker.checkAccess).not.toHaveBeenCalled()
      expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
    })
  })

  describe('when the world access is not allowlist', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeerWorld.mockReturnValue('world-1')
      mockAccessChecker.getWorldAccess.mockResolvedValue({ type: AccessType.Unrestricted })
    })

    it('should not check access or kick the member', async () => {
      await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

      expect(mockAccessChecker.getWorldAccess).toHaveBeenCalledWith('world-1')
      expect(mockAccessChecker.checkAccess).not.toHaveBeenCalled()
      expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
    })
  })

  describe('when the member is connected', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeerWorld.mockReturnValue('world-1')
    })

    describe('and still has access (via wallet or another community)', () => {
      beforeEach(() => {
        mockAccessChecker.checkAccess.mockResolvedValue(true)
      })

      it('should get world access', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockAccessChecker.getWorldAccess).toHaveBeenCalledWith('world-1')
      })

      it('should re-validate access', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockAccessChecker.checkAccess).toHaveBeenCalledWith('world-1', '0xAlice')
      })

      it('should not kick the member', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
      })
    })

    describe('and no longer has access', () => {
      beforeEach(() => {
        mockAccessChecker.checkAccess.mockResolvedValue(false)
      })

      it('should get world access', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockAccessChecker.getWorldAccess).toHaveBeenCalledWith('world-1')
      })

      it('should re-check access', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockAccessChecker.checkAccess).toHaveBeenCalledWith('world-1', '0xAlice')
      })

      it('should kick the member from MEMBER_REMOVED event', async () => {
        await handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))

        expect(mockParticipantKicker.kickParticipant).toHaveBeenCalledWith('world-1', '0xAlice')
      })

      it('should kick the member from MEMBER_BANNED event', async () => {
        await handler.handle(createMemberBannedEvent('community-1', '0xAlice'))

        expect(mockParticipantKicker.kickParticipant).toHaveBeenCalledWith('world-1', '0xAlice')
      })

      it('should kick the member from MEMBER_LEFT event', async () => {
        await handler.handle(createMemberLeftEvent('community-1', '0xAlice'))

        expect(mockParticipantKicker.kickParticipant).toHaveBeenCalledWith('world-1', '0xAlice')
      })
    })
  })

  describe('when getWorldAccess throws', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeerWorld.mockReturnValue('world-1')
      mockAccessChecker.getWorldAccess.mockRejectedValue(new Error('get world access failed'))
    })

    it('should not throw and should not kick', async () => {
      await expect(handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))).resolves.toBeUndefined()

      expect(mockAccessChecker.checkAccess).not.toHaveBeenCalled()
      expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
    })
  })

  describe('when access check throws', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeerWorld.mockReturnValue('world-1')
      mockAccessChecker.checkAccess.mockRejectedValue(new Error('access check failed'))
    })

    it('should not throw and should not kick', async () => {
      await expect(handler.handle(createMemberRemovedEvent('community-1', '0xAlice'))).resolves.toBeUndefined()

      expect(mockParticipantKicker.kickParticipant).not.toHaveBeenCalled()
    })
  })
})
