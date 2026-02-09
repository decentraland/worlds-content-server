import { createAccessChangeHandler } from '../../src/logic/access-change-handler'
import { IParticipantKicker } from '../../src/logic/participant-kicker'
import { AccessType } from '../../src/logic/access/types'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'

function createMockParticipantKicker(): jest.Mocked<IParticipantKicker> {
  return {
    kickInBatches: jest.fn().mockResolvedValue(undefined)
  }
}

function createMockAccessChecker(): jest.Mocked<IAccessCheckerComponent> {
  return {
    checkAccess: jest.fn().mockResolvedValue(false)
  }
}

describe('AccessChangeHandler', () => {
  const mockParticipantKicker = createMockParticipantKicker()
  const mockAccessChecker = createMockAccessChecker()
  const mockPeersRegistry = {
    getPeersInWorld: jest.fn().mockReturnValue(['0xalice'])
  }
  const mockLogs = {
    getLogger: jest.fn().mockReturnValue({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    })
  }
  const accessChangeHandler = createAccessChangeHandler({
    peersRegistry: mockPeersRegistry as any,
    participantKicker: mockParticipantKicker,
    logs: mockLogs as any,
    accessChecker: mockAccessChecker
  })

  describe('when access type transition requires no kick (same type)', () => {
    const noKickTransitions: Array<{ from: AccessType; to: AccessType }> = [
      { from: AccessType.Unrestricted, to: AccessType.Unrestricted },
      { from: AccessType.SharedSecret, to: AccessType.SharedSecret },
      { from: AccessType.AllowList, to: AccessType.AllowList }
    ]

    noKickTransitions.forEach(({ from, to }) => {
      it(`should not kick participants for ${from} -> ${to}`, async () => {
        mockParticipantKicker.kickInBatches.mockClear()
        await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
        expect(mockParticipantKicker.kickInBatches).not.toHaveBeenCalled()
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
        mockParticipantKicker.kickInBatches.mockClear()
        await accessChangeHandler.handleAccessChange('world', { type: from } as any, { type: to } as any)
        expect(mockParticipantKicker.kickInBatches).toHaveBeenCalledWith('world', ['0xalice'])
      })
    })

    it('should kick all when NFT is involved (NFT skipped in matrix)', async () => {
      mockParticipantKicker.kickInBatches.mockClear()
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.NFTOwnership } as any,
        { type: AccessType.Unrestricted } as any
      )
      expect(mockParticipantKicker.kickInBatches).toHaveBeenCalledWith('world', ['0xalice'])
    })
  })

  describe('when handleAccessChange is called', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xalice', '0xbob'])
      mockParticipantKicker.kickInBatches.mockClear()
    })

    it('should skip reaction when no participants in world', async () => {
      mockPeersRegistry.getPeersInWorld.mockReturnValueOnce([])
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.Unrestricted },
        { type: AccessType.SharedSecret, secret: 'x' }
      )
      expect(mockParticipantKicker.kickInBatches).not.toHaveBeenCalled()
    })

    it('should apply reaction when participants exist', async () => {
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.Unrestricted },
        { type: AccessType.SharedSecret, secret: 'x' }
      )
      expect(mockParticipantKicker.kickInBatches).toHaveBeenCalledWith('world', ['0xalice', '0xbob'])
    })

    it('should not throw when reaction fails (errors are logged)', async () => {
      mockParticipantKicker.kickInBatches.mockRejectedValueOnce(new Error('kick failed'))
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
