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

  describe.each([
    { from: AccessType.Unrestricted, to: AccessType.Unrestricted },
    { from: AccessType.SharedSecret, to: AccessType.SharedSecret },
    { from: AccessType.AllowList, to: AccessType.AllowList },
    { from: AccessType.SharedSecret, to: AccessType.Unrestricted },
    { from: AccessType.AllowList, to: AccessType.Unrestricted },
    { from: AccessType.NFTOwnership, to: AccessType.Unrestricted }
  ])('when transitioning from $from to $to (no kick)', ({ from, to }) => {
    it('should not kick participants', async () => {
      await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
      expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
    })
  })

  describe.each([
    { from: AccessType.Unrestricted, to: AccessType.SharedSecret },
    { from: AccessType.Unrestricted, to: AccessType.AllowList },
    { from: AccessType.SharedSecret, to: AccessType.AllowList },
    { from: AccessType.AllowList, to: AccessType.SharedSecret }
  ])('when transitioning from $from to $to (type changed, kick all)', ({ from, to }) => {
    it('should kick all participants', async () => {
      await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
      expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
    })
  })

  describe('when transitioning between different access types', () => {
    let previousAccess: any
    let newAccess: any

    beforeEach(() => {
      previousAccess = { type: AccessType.Unrestricted }
      newAccess = { type: AccessType.SharedSecret, secret: 'x' }
    })

    describe('and no participants are in the world', () => {
      beforeEach(() => {
        mockPeersRegistry.getPeersInWorld.mockReturnValue([])
      })

      it('should not kick participants', async () => {
        await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
        expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
      })
    })

    describe('and participants exist in the world', () => {
      beforeEach(() => {
        mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants', async () => {
        await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
        expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice', '0xbob'])
      })

      describe('and the kick fails', () => {
        beforeEach(() => {
          mockParticipantKicker.kickParticipants.mockRejectedValue(new Error('kick failed'))
        })

        it('should not throw', async () => {
          await expect(
            accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
          ).resolves.toBeUndefined()
        })
      })
    })
  })
})
