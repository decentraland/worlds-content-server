import { ILoggerComponent } from '@well-known-components/interfaces'
import { createAccessChangeHandler } from '../../src/logic/access-change-handler'
import { IAccessChangeHandler } from '../../src/logic/access-change-handler/types'
import { AccessType } from '../../src/logic/access/types'
import { IParticipantKicker } from '../../src/logic/participant-kicker'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'
import { IPeersRegistry } from '../../src/types'
import { createMockParticipantKicker } from '../mocks/participant-kicker-mock'
import { createMockAccessChecker } from '../mocks/access-checker-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { createMockLogs } from '../mocks/logs-mock'

describe('AccessChangeHandler', () => {
  let mockParticipantKicker: jest.Mocked<IParticipantKicker>
  let mockAccessChecker: jest.Mocked<IAccessCheckerComponent>
  let mockPeersRegistry: jest.Mocked<IPeersRegistry>
  let mockLogs: jest.Mocked<ILoggerComponent>
  let accessChangeHandler: IAccessChangeHandler

  beforeEach(() => {
    mockParticipantKicker = createMockParticipantKicker()
    mockAccessChecker = createMockAccessChecker()
    mockPeersRegistry = createMockPeersRegistry()
    mockLogs = createMockLogs()
    mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xalice'])

    accessChangeHandler = createAccessChangeHandler({
      peersRegistry: mockPeersRegistry,
      participantKicker: mockParticipantKicker,
      logs: mockLogs,
      accessChecker: mockAccessChecker
    })
  })

  describe('when access type transition requires no kick (same type)', () => {
    const noKickTransitions: Array<{ from: AccessType; to: AccessType }> = [
      { from: AccessType.Unrestricted, to: AccessType.Unrestricted },
      { from: AccessType.SharedSecret, to: AccessType.SharedSecret },
      { from: AccessType.AllowList, to: AccessType.AllowList }
    ]

    noKickTransitions.forEach(({ from, to }) => {
      it(`should not kick participants for ${from} -> ${to}`, async () => {
        mockParticipantKicker.kickParticipants.mockClear()
        await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
        expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
      })
    })
  })

  describe('when access type transition requires kick all (type changed)', () => {
    const kickAllTransitions: Array<{ from: AccessType; to: AccessType }> = [
      { from: AccessType.Unrestricted, to: AccessType.SharedSecret },
      { from: AccessType.Unrestricted, to: AccessType.AllowList },
      { from: AccessType.SharedSecret, to: AccessType.Unrestricted },
      { from: AccessType.SharedSecret, to: AccessType.AllowList },
      { from: AccessType.AllowList, to: AccessType.Unrestricted },
      { from: AccessType.AllowList, to: AccessType.SharedSecret }
    ]

    kickAllTransitions.forEach(({ from, to }) => {
      it(`should kick all participants for ${from} -> ${to}`, async () => {
        mockParticipantKicker.kickParticipants.mockClear()
        await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
        expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
      })
    })

    it('should kick all when NFT is involved (NFT skipped in matrix)', async () => {
      mockParticipantKicker.kickParticipants.mockClear()
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.NFTOwnership } as any,
        { type: AccessType.Unrestricted } as any
      )
      expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
    })
  })

  describe('when handleAccessChange is called', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xalice', '0xbob'])
      mockParticipantKicker.kickParticipants.mockClear()
    })

    it('should skip reaction when no participants in world', async () => {
      mockPeersRegistry.getPeersInWorld.mockReturnValueOnce([])
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.Unrestricted },
        { type: AccessType.SharedSecret, secret: 'x' }
      )
      expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
    })

    it('should apply reaction when participants exist', async () => {
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.Unrestricted },
        { type: AccessType.SharedSecret, secret: 'x' }
      )
      expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice', '0xbob'])
    })

    it('should not throw when reaction fails (errors are logged)', async () => {
      mockParticipantKicker.kickParticipants.mockRejectedValueOnce(new Error('kick failed'))
      await expect(
        accessChangeHandler.handleAccessChange(
          'world',
          { type: AccessType.Unrestricted },
          { type: AccessType.SharedSecret, secret: 'x' }
        )
      ).resolves.toBeUndefined()
    })
  })
})
