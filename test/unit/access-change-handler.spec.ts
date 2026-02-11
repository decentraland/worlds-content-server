import { ILoggerComponent } from '@well-known-components/interfaces'
import { createAccessChangeHandler } from '../../src/logic/access-change-handler'
import { IAccessChangeHandler } from '../../src/logic/access-change-handler/types'
import { AccessType } from '../../src/logic/access/types'
import { IParticipantKicker } from '../../src/logic/participant-kicker'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'
import { IPeersRegistry, IPermissionsManager } from '../../src/types'
import { createMockParticipantKicker } from '../mocks/participant-kicker-mock'
import { createMockAccessChecker } from '../mocks/access-checker-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockedPermissionsManager } from '../mocks/permissions-manager-mock'

describe('AccessChangeHandler', () => {
  let mockParticipantKicker: jest.Mocked<IParticipantKicker>
  let mockAccessChecker: jest.Mocked<IAccessCheckerComponent>
  let mockPeersRegistry: jest.Mocked<IPeersRegistry>
  let mockPermissionsManager: jest.Mocked<IPermissionsManager>
  let mockLogs: jest.Mocked<ILoggerComponent>
  let accessChangeHandler: IAccessChangeHandler

  beforeEach(() => {
    mockParticipantKicker = createMockParticipantKicker()
    mockAccessChecker = createMockAccessChecker()
    mockPeersRegistry = createMockPeersRegistry()
    mockPermissionsManager = createMockedPermissionsManager({
      getOwner: jest.fn().mockResolvedValue(undefined),
      getWorldPermissionRecords: jest.fn().mockResolvedValue([])
    })
    mockLogs = createMockLogs()
    mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xalice'])

    accessChangeHandler = createAccessChangeHandler({
      peersRegistry: mockPeersRegistry,
      participantKicker: mockParticipantKicker,
      logs: mockLogs,
      accessChecker: mockAccessChecker,
      permissionsManager: mockPermissionsManager
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

  describe('when a participant is the world owner', () => {
    let previousAccess: any
    let newAccess: any

    beforeEach(() => {
      previousAccess = { type: AccessType.Unrestricted }
      newAccess = { type: AccessType.SharedSecret, secret: 'x' }
      mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xowner', '0xalice'])
      mockPermissionsManager.getOwner.mockResolvedValue('0xowner')
    })

    it('should not kick the world owner', async () => {
      await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
      expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
    })

    describe('and the owner is the only participant', () => {
      beforeEach(() => {
        mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xowner'])
      })

      it('should not kick anyone', async () => {
        await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
        expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
      })
    })

    describe('and the access changes from AllowList to AllowList', () => {
      beforeEach(() => {
        previousAccess = { type: AccessType.AllowList, wallets: ['0xowner', '0xalice'], communities: [] }
        newAccess = { type: AccessType.AllowList, wallets: ['0xowner'], communities: [] }
        mockAccessChecker.checkAccess.mockImplementation(async (_worldName, ethAddress) => {
          return ethAddress === '0xowner'
        })
      })

      it('should not kick the world owner even if they lost allow-list access', async () => {
        await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
        expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
      })
    })
  })

  describe('when a participant has deployment permission', () => {
    let previousAccess: any
    let newAccess: any

    beforeEach(() => {
      previousAccess = { type: AccessType.Unrestricted }
      newAccess = { type: AccessType.SharedSecret, secret: 'x' }
      mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xdeployer', '0xalice'])
      mockPermissionsManager.getWorldPermissionRecords.mockResolvedValue([
        { permissionType: 'deployment', address: '0xdeployer' } as any
      ])
    })

    it('should not kick the deployer', async () => {
      await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
      expect(mockParticipantKicker.kickParticipants).toHaveBeenCalledWith('world', ['0xalice'])
    })

    describe('and the deployer is the only participant', () => {
      beforeEach(() => {
        mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xdeployer'])
      })

      it('should not kick anyone', async () => {
        await accessChangeHandler.handleAccessChange('world', previousAccess, newAccess)
        expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
      })
    })
  })

  describe('when all participants are privileged', () => {
    beforeEach(() => {
      mockPeersRegistry.getPeersInWorld.mockReturnValue(['0xowner', '0xdeployer'])
      mockPermissionsManager.getOwner.mockResolvedValue('0xowner')
      mockPermissionsManager.getWorldPermissionRecords.mockResolvedValue([
        { permissionType: 'deployment', address: '0xdeployer' } as any
      ])
    })

    it('should not kick anyone', async () => {
      await accessChangeHandler.handleAccessChange(
        'world',
        { type: AccessType.Unrestricted } as any,
        { type: AccessType.SharedSecret, secret: 'x' } as any
      )
      expect(mockParticipantKicker.kickParticipants).not.toHaveBeenCalled()
    })
  })
})
