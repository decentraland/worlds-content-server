import { createAccessComponent } from '../../src/logic/access'
import { createAccessCheckerComponent } from '../../src/logic/access-checker'
import { createAccessChangeHandler } from '../../src/logic/access-change-handler'
import { createParticipantKicker } from '../../src/logic/participant-kicker'
import { AccessSetting, AccessType, IAccessComponent } from '../../src/logic/access/types'
import {
  InvalidAccessTypeError,
  InvalidAllowListSettingError,
  NotAllowListAccessError,
  UnauthorizedCommunityError
} from '../../src/logic/access/errors'
import { DEFAULT_MAX_COMMUNITIES, DEFAULT_MAX_WALLETS } from '../../src/logic/access/constants'
import { GetRawWorldRecordsResult, ICommsAdapter, IWorldsManager, WorldRecord } from '../../src/types'
import { ISocialServiceComponent } from '../../src/adapters/social-service'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockPeersRegistry } from '../mocks/peers-registry-mock'
import { createMockCommsAdapterComponent } from '../mocks/comms-adapter-mock'
import { createMockedPermissionsManager } from '../mocks/permissions-manager-mock'
import { createMockedSnsClient } from '../mocks/sns-client-mock'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { Events, WorldSettingsChangedEvent } from '@dcl/schemas'
import { IPublisherComponent } from '@dcl/sns-component'
import bcrypt from 'bcrypt'

const TEST_SIGNER = '0xSigner'

/**
 * Helper to create a mock response for getRawWorldRecords
 */
function mockRawWorldRecords(access?: AccessSetting): GetRawWorldRecordsResult {
  if (!access) {
    return { records: [], total: 0 }
  }
  return {
    records: [{ access } as WorldRecord],
    total: 1
  }
}

describe('AccessComponent', () => {
  let accessComponent: IAccessComponent
  let worldsManager: jest.Mocked<IWorldsManager>
  let socialService: jest.Mocked<ISocialServiceComponent>
  let snsClient: jest.Mocked<IPublisherComponent>
  let config: ReturnType<typeof createMockedConfig>
  let peersRegistry: ReturnType<typeof createMockPeersRegistry>
  let commsAdapter: jest.Mocked<ICommsAdapter>
  let logs: jest.Mocked<ILoggerComponent>

  beforeEach(async () => {
    worldsManager = {
      getRawWorldRecords: jest.fn(),
      storeAccess: jest.fn(),
      createBasicWorldIfNotExists: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    socialService = {
      getMemberCommunities: jest.fn().mockResolvedValue({ communities: [] })
    } as unknown as jest.Mocked<ISocialServiceComponent>

    config = createMockedConfig({
      getNumber: jest.fn((key: string) =>
        Promise.resolve(
          {
            ACCESS_MAX_COMMUNITIES: DEFAULT_MAX_COMMUNITIES,
            ACCESS_MAX_WALLETS: DEFAULT_MAX_WALLETS,
            ACCESS_KICK_BATCH_SIZE: 20
          }[key]
        )
      ),
      requireString: jest.fn((key: string) => Promise.resolve(key === 'COMMS_ROOM_PREFIX' ? 'world-' : 'unknown'))
    })

    snsClient = createMockedSnsClient()

    peersRegistry = createMockPeersRegistry()
    commsAdapter = createMockCommsAdapterComponent() as jest.Mocked<ICommsAdapter>
    commsAdapter.removeParticipant = jest.fn().mockResolvedValue(undefined)

    logs = {
      getLogger: jest.fn(() => ({
        log: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }))
    } as unknown as jest.Mocked<ILoggerComponent>

    const participantKicker = await createParticipantKicker({ peersRegistry, commsAdapter, logs, config })
    const accessChecker = await createAccessCheckerComponent({ worldsManager, socialService })
    const permissionsManager = createMockedPermissionsManager({
      getOwner: jest.fn().mockResolvedValue(undefined),
      getWorldPermissionRecords: jest.fn().mockResolvedValue([])
    })
    const accessChangeHandler = createAccessChangeHandler({
      peersRegistry,
      participantKicker,
      logs,
      accessChecker,
      permissionsManager
    })
    accessComponent = await createAccessComponent({
      config,
      socialService,
      worldsManager,
      accessChangeHandler,
      accessChecker,
      snsClient
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when setting access', () => {
    describe('and setting unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should store unrestricted access setting', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.Unrestricted })

        expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
          type: AccessType.Unrestricted
        })
      })
    })

    describe('and setting allow-list access', () => {
      beforeEach(() => {
        // Mock for getting previous access (default unrestricted)
        worldsManager.getRawWorldRecords.mockResolvedValue(mockRawWorldRecords())
      })

      describe('and wallets are provided', () => {
        it('should store allow-list access setting with wallets', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678']
          })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678'],
            communities: []
          })
        })
      })

      describe('and wallets are not provided', () => {
        it('should store allow-list access setting with empty wallets', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.AllowList })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: [],
            communities: []
          })
        })
      })

      describe('and communities are provided', () => {
        describe('and the signer is a member of all communities', () => {
          beforeEach(() => {
            socialService.getMemberCommunities.mockResolvedValueOnce({
              communities: [{ id: 'community-1' }, { id: 'community-2' }]
            })
          })

          it('should store allow-list access setting with communities', async () => {
            await accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: ['community-1', 'community-2']
            })

            expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: ['community-1', 'community-2']
            })
          })

          it('should validate community membership with the signer address', async () => {
            await accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: ['community-1', 'community-2']
            })

            expect(socialService.getMemberCommunities).toHaveBeenCalledWith(TEST_SIGNER, ['community-1', 'community-2'])
          })
        })

        describe('and the signer is not a member of some communities', () => {
          beforeEach(() => {
            socialService.getMemberCommunities.mockResolvedValueOnce({
              communities: [{ id: 'community-1' }]
            })
          })

          it('should throw UnauthorizedCommunityError', async () => {
            await expect(
              accessComponent.setAccess('test-world', TEST_SIGNER, {
                type: AccessType.AllowList,
                wallets: ['0x1234'],
                communities: ['community-1', 'community-2']
              })
            ).rejects.toThrow(UnauthorizedCommunityError)
          })

          it('should include the unauthorized communities in the error message', async () => {
            await expect(
              accessComponent.setAccess('test-world', TEST_SIGNER, {
                type: AccessType.AllowList,
                wallets: ['0x1234'],
                communities: ['community-1', 'community-2']
              })
            ).rejects.toThrow('community-2')
          })
        })

        describe('and the signer is not a member of any community', () => {
          beforeEach(() => {
            socialService.getMemberCommunities.mockResolvedValueOnce({ communities: [] })
          })

          it('should throw UnauthorizedCommunityError with all communities', async () => {
            await expect(
              accessComponent.setAccess('test-world', TEST_SIGNER, {
                type: AccessType.AllowList,
                wallets: ['0x1234'],
                communities: ['community-1', 'community-2']
              })
            ).rejects.toThrow('community-1, community-2')
          })
        })
      })

      describe('and communities array is empty', () => {
        it('should store allow-list access setting without communities field', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: []
          })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: []
          })
        })

        it('should not call socialService to validate communities', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: []
          })

          expect(socialService.getMemberCommunities).not.toHaveBeenCalled()
        })
      })

      describe('and communities exceed the maximum limit', () => {
        let tooManyCommunities: string[]

        beforeEach(() => {
          tooManyCommunities = Array.from({ length: DEFAULT_MAX_COMMUNITIES + 1 }, (_, i) => `community-${i}`)
        })

        it('should throw InvalidAllowListSettingError', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: tooManyCommunities
            })
          ).rejects.toThrow(InvalidAllowListSettingError)
        })

        it('should include the limit in the error message', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: tooManyCommunities
            })
          ).rejects.toThrow(`Maximum allowed is ${DEFAULT_MAX_COMMUNITIES}`)
        })
      })

      describe('and wallets exceed the maximum limit', () => {
        let tooManyWallets: string[]

        beforeEach(() => {
          tooManyWallets = Array.from({ length: DEFAULT_MAX_WALLETS + 1 }, (_, i) => `0x${String(i).padStart(40, '0')}`)
        })

        it('should throw InvalidAllowListSettingError', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: tooManyWallets,
              communities: []
            })
          ).rejects.toThrow(InvalidAllowListSettingError)
        })

        it('should include the wallet limit in the error message', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: tooManyWallets,
              communities: []
            })
          ).rejects.toThrow(`Maximum allowed is ${DEFAULT_MAX_WALLETS}`)
        })
      })

      describe('and communities are at the maximum limit', () => {
        let maxCommunities: string[]

        beforeEach(() => {
          maxCommunities = Array.from({ length: DEFAULT_MAX_COMMUNITIES }, (_, i) => `community-${i}`)
          socialService.getMemberCommunities.mockResolvedValueOnce({
            communities: maxCommunities.map((id) => ({ id }))
          })
        })

        it('should store allow-list access setting with communities', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: maxCommunities
          })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: maxCommunities
          })
        })
      })
    })

    describe('and setting shared-secret access', () => {
      beforeEach(() => {
        // Mock for getting previous access
        worldsManager.getRawWorldRecords.mockResolvedValue(mockRawWorldRecords())
      })

      describe('and a secret is provided', () => {
        let storedAccess: any

        beforeEach(async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.SharedSecret,
            secret: 'my-secret'
          })
          storedAccess = worldsManager.storeAccess.mock.calls[0][1]
        })

        it('should store the access with SharedSecret type', () => {
          expect(storedAccess.type).toBe(AccessType.SharedSecret)
        })

        it('should store a hashed secret that matches the original', () => {
          expect('secret' in storedAccess && bcrypt.compareSync('my-secret', storedAccess.secret)).toBe(true)
        })
      })

      describe('and a secret is not provided', () => {
        it('should throw InvalidAccessTypeError', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.SharedSecret })
          ).rejects.toThrow(InvalidAccessTypeError)
        })
      })
    })

    describe('and setting nft-ownership access', () => {
      beforeEach(() => {
        // Mock for getting previous access
        worldsManager.getRawWorldRecords.mockResolvedValue(mockRawWorldRecords())
      })

      describe('and an nft is provided', () => {
        it('should store nft access setting', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.NFTOwnership,
            nft: 'some-nft-address'
          })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.NFTOwnership,
            nft: 'some-nft-address'
          })
        })
      })

      describe('and an nft is not provided', () => {
        it('should throw InvalidAccessTypeError', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.NFTOwnership })
          ).rejects.toThrow(InvalidAccessTypeError)
        })
      })
    })

    describe('and setting an invalid access type', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValue(mockRawWorldRecords())
      })

      it('should throw InvalidAccessTypeError', async () => {
        await expect(accessComponent.setAccess('test-world', TEST_SIGNER, { type: 'invalid-type' })).rejects.toThrow(
          InvalidAccessTypeError
        )
      })
    })

    describe('and publishing the world settings changed event', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValue(mockRawWorldRecords())
        jest.spyOn(Date, 'now').mockReturnValue(1234567890)
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('should publish a WorldSettingsChangedEvent via SNS', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.Unrestricted })

        expect(snsClient.publishMessage).toHaveBeenCalledWith({
          type: Events.Type.WORLD,
          subType: Events.SubType.Worlds.WORLD_SETTINGS_CHANGED,
          key: 'test-world-1234567890',
          timestamp: 1234567890,
          metadata: {
            accessType: AccessType.Unrestricted
          }
        } satisfies WorldSettingsChangedEvent)
      })

      it('should include the access type in the event metadata', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.AllowList,
          wallets: ['0x1234']
        })

        expect(snsClient.publishMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: { accessType: AccessType.AllowList }
          })
        )
      })

      it('should use the world name and timestamp as the event key', async () => {
        await accessComponent.setAccess('my-world.dcl.eth', TEST_SIGNER, { type: AccessType.Unrestricted })

        expect(snsClient.publishMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            key: 'my-world.dcl.eth-1234567890'
          })
        )
      })
    })
  })

  describe('when adding a wallet to access allow list', () => {
    describe('and the world has allow-list access', () => {
      describe('and the wallet is not in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234'], communities: ['community-1'] })
          )
        })

        it('should add the wallet to the list', async () => {
          await accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x5678')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678'],
            communities: ['community-1']
          })
        })
      })

      describe('and the wallet is already in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0x5678'], communities: [] })
          )
        })

        it('should not add the wallet again (idempotent)', async () => {
          await accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x5678')

          expect(worldsManager.storeAccess).not.toHaveBeenCalled()
        })
      })

      describe('and the wallet is already in the list with different case', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'], communities: [] })
          )
        })

        it('should not add the wallet again (case insensitive)', async () => {
          await accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0xabcd')

          expect(worldsManager.storeAccess).not.toHaveBeenCalled()
        })
      })

      describe('and the wallets array is empty', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: [] })
          )
        })

        it('should add the wallet to the empty list', async () => {
          await accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x5678')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x5678'],
            communities: []
          })
        })
      })

      describe('and adding would exceed the maximum wallets', () => {
        beforeEach(async () => {
          const configWithLowLimit = createMockedConfig({
            getNumber: jest.fn((key: string) =>
              Promise.resolve(
                key === 'ACCESS_MAX_COMMUNITIES'
                  ? DEFAULT_MAX_COMMUNITIES
                  : key === 'ACCESS_MAX_WALLETS'
                    ? 2
                    : key === 'ACCESS_KICK_BATCH_SIZE'
                      ? 20
                      : undefined
              )
            ),
            requireString: jest.fn((key: string) => Promise.resolve(key === 'COMMS_ROOM_PREFIX' ? 'world-' : 'unknown'))
          })
          const participantKickerWithLowLimit = await createParticipantKicker({
            peersRegistry,
            commsAdapter,
            logs,
            config: configWithLowLimit
          })
          const accessCheckerWithLowLimit = await createAccessCheckerComponent({ worldsManager, socialService })
          const permissionsManagerWithLowLimit = createMockedPermissionsManager({
            getOwner: jest.fn().mockResolvedValue(undefined),
            getWorldPermissionRecords: jest.fn().mockResolvedValue([])
          })
          const accessChangeHandlerWithLowLimit = createAccessChangeHandler({
            peersRegistry,
            participantKicker: participantKickerWithLowLimit,
            logs,
            accessChecker: accessCheckerWithLowLimit,
            permissionsManager: permissionsManagerWithLowLimit
          })
          accessComponent = await createAccessComponent({
            config: configWithLowLimit,
            socialService,
            worldsManager,
            accessChangeHandler: accessChangeHandlerWithLowLimit,
            accessChecker: accessCheckerWithLowLimit,
            snsClient
          })
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: ['0x1234', '0x5678'],
              communities: []
            })
          )
        })

        it('should throw InvalidAllowListSettingError', async () => {
          await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0xabcd')).rejects.toThrow(
            InvalidAllowListSettingError
          )
        })

        it('should include the maximum wallets in the error message', async () => {
          await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0xabcd')).rejects.toThrow(
            'maximum of 2 wallets'
          )
        })
      })
    })

    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })

      it('should include the world name in the error message', async () => {
        await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x1234')).rejects.toThrow(
          'test-world'
        )
      })
    })

    describe('and the world has shared-secret access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'hashed-secret' })
        )
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })

    describe('and the world has nft-ownership access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.NFTOwnership, nft: 'some-nft' })
        )
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })

    describe('and the world has no metadata (no access record)', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords())
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.addWalletToAccessAllowList('test-world', TEST_SIGNER, '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })
  })

  describe('when removing a wallet from access allow list', () => {
    describe('and the world has allow-list access', () => {
      describe('and the wallet is in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: ['0x1234', '0x5678'],
              communities: ['community-1']
            })
          )
        })

        it('should remove the wallet from the list', async () => {
          await accessComponent.removeWalletFromAccessAllowList('test-world', '0x5678')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: ['community-1']
          })
        })
      })

      describe('and the wallet is in the list with different case', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'], communities: [] })
          )
        })

        it('should remove the wallet (case insensitive)', async () => {
          await accessComponent.removeWalletFromAccessAllowList('test-world', '0xabcd')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: []
          })
        })
      })

      describe('and the wallet is not in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234'], communities: [] })
          )
        })

        it('should update the access with the same list (idempotent)', async () => {
          await accessComponent.removeWalletFromAccessAllowList('test-world', '0x5678')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: []
          })
        })
      })

      describe('and it is the last wallet in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234'], communities: [] })
          )
        })

        it('should leave an empty wallets list', async () => {
          await accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: [],
            communities: []
          })
        })
      })
    })

    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })

      it('should include the world name in the error message', async () => {
        await expect(accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')).rejects.toThrow(
          'test-world'
        )
      })
    })

    describe('and the world has shared-secret access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'hashed-secret' })
        )
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })

    describe('and the world has nft-ownership access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.NFTOwnership, nft: 'some-nft' })
        )
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })

    describe('and the world has no metadata (no access record)', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords())
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.removeWalletFromAccessAllowList('test-world', '0x1234')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })
  })

  describe('when adding a community to access allow list', () => {
    describe('and the world has allow-list access', () => {
      describe('and the signer is a member of the community', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-1'] })
          )
          socialService.getMemberCommunities.mockResolvedValue({ communities: [{ id: 'community-2' }] })
        })

        it('should add the community to the list', async () => {
          await accessComponent.addCommunityToAccessAllowList('test-world', TEST_SIGNER, 'community-2')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: [],
            communities: ['community-1', 'community-2']
          })
        })
      })

      describe('and the community is already in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: [],
              communities: ['community-1', 'community-2']
            })
          )
          socialService.getMemberCommunities.mockResolvedValue({ communities: [{ id: 'community-2' }] })
        })

        it('should not add the community again (idempotent)', async () => {
          await accessComponent.addCommunityToAccessAllowList('test-world', TEST_SIGNER, 'community-2')

          expect(worldsManager.storeAccess).not.toHaveBeenCalled()
        })
      })

      describe('and the signer is not a member of the community', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: [] })
          )
          socialService.getMemberCommunities.mockResolvedValue({ communities: [] })
        })

        it('should throw UnauthorizedCommunityError', async () => {
          await expect(
            accessComponent.addCommunityToAccessAllowList('test-world', TEST_SIGNER, 'community-1')
          ).rejects.toThrow(UnauthorizedCommunityError)
        })
      })

      describe('and the communities list is at MAX_COMMUNITIES', () => {
        beforeEach(() => {
          const fullList = Array.from({ length: DEFAULT_MAX_COMMUNITIES }, (_, i) => `community-${i}`)
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: fullList })
          )
          socialService.getMemberCommunities.mockResolvedValue({ communities: [{ id: 'new-community' }] })
        })

        it('should throw InvalidAllowListSettingError', async () => {
          await expect(
            accessComponent.addCommunityToAccessAllowList('test-world', TEST_SIGNER, 'new-community')
          ).rejects.toThrow(InvalidAllowListSettingError)
        })
      })
    })

    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(
          accessComponent.addCommunityToAccessAllowList('test-world', TEST_SIGNER, 'community-1')
        ).rejects.toThrow(NotAllowListAccessError)
      })
    })
  })

  describe('when removing a community from access allow list', () => {
    describe('and the world has allow-list access', () => {
      describe('and the community is in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: ['community-1', 'community-2']
            })
          )
        })

        it('should remove the community from the list', async () => {
          await accessComponent.removeCommunityFromAccessAllowList('test-world', 'community-2')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234'],
            communities: ['community-1']
          })
        })
      })

      describe('and the community is not in the list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-1'] })
          )
        })

        it('should update the access with the same list (idempotent)', async () => {
          await accessComponent.removeCommunityFromAccessAllowList('test-world', 'community-2')

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: [],
            communities: ['community-1']
          })
        })
      })
    })

    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should throw NotAllowListAccessError', async () => {
        await expect(accessComponent.removeCommunityFromAccessAllowList('test-world', 'community-1')).rejects.toThrow(
          NotAllowListAccessError
        )
      })
    })
  })

  describe('when getting access for world', () => {
    describe('and the world exists with access defined', () => {
      describe('and the access is unrestricted', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        })

        it('should return the unrestricted access setting', async () => {
          const result = await accessComponent.getAccessForWorld('test-world')

          expect(result).toEqual({ type: AccessType.Unrestricted })
        })
      })

      describe('and the access is allow-list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: ['0x1234', '0x5678'],
              communities: ['community-1']
            })
          )
        })

        it('should return the allow-list access setting', async () => {
          const result = await accessComponent.getAccessForWorld('test-world')

          expect(result).toEqual({
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678'],
            communities: ['community-1']
          })
        })
      })

      describe('and the access is shared-secret', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'hashed-secret' })
          )
        })

        it('should return the shared-secret access setting', async () => {
          const result = await accessComponent.getAccessForWorld('test-world')

          expect(result).toEqual({ type: AccessType.SharedSecret, secret: 'hashed-secret' })
        })
      })

      describe('and the access is nft-ownership', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.NFTOwnership, nft: 'some-nft' })
          )
        })

        it('should return the nft-ownership access setting', async () => {
          const result = await accessComponent.getAccessForWorld('test-world')

          expect(result).toEqual({ type: AccessType.NFTOwnership, nft: 'some-nft' })
        })
      })
    })

    describe('and the world does not exist', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords())
      })

      it('should return the default unrestricted access', async () => {
        const result = await accessComponent.getAccessForWorld('non-existent-world')

        expect(result).toEqual({ type: AccessType.Unrestricted })
      })
    })

    describe('and the world exists but has no access defined', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce({
          records: [{ access: undefined } as WorldRecord],
          total: 1
        })
      })

      it('should return the default unrestricted access', async () => {
        const result = await accessComponent.getAccessForWorld('test-world')

        expect(result).toEqual({ type: AccessType.Unrestricted })
      })
    })

    describe('and the world exists but access is null', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce({
          records: [{ access: null } as unknown as WorldRecord],
          total: 1
        })
      })

      it('should return the default unrestricted access', async () => {
        const result = await accessComponent.getAccessForWorld('test-world')

        expect(result).toEqual({ type: AccessType.Unrestricted })
      })
    })

    it('should call getRawWorldRecords with the correct world name', async () => {
      worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))

      await accessComponent.getAccessForWorld('my-world.dcl.eth')

      expect(worldsManager.getRawWorldRecords).toHaveBeenCalledWith({ worldName: 'my-world.dcl.eth' })
    })
  })

  describe('when setting access with participants to kick', () => {
    beforeEach(() => {
      // Mock getPeerRooms to return both comms and scene rooms
      peersRegistry.getPeerRooms = jest.fn((_identity: string) => {
        // Return both world room and a scene room for each peer
        const worldName = 'test-world'
        return [`world-${worldName}`, `world-scene-room-${worldName}-scene1`]
      })
    })

    describe('and transitioning from Unrestricted to AllowList', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob', '0xcharlie'])
      })

      describe('and all participants are in the new allow list', () => {
        beforeEach(() => {
          // Second call: for checking individual access after storing
          worldsManager.getRawWorldRecords.mockResolvedValue(
            mockRawWorldRecords({
              type: AccessType.AllowList,
              wallets: ['0xalice', '0xbob', '0xcharlie'],
              communities: []
            })
          )
        })

        it('should kick all participants (type changed)', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xalice', '0xbob', '0xcharlie']
          })

          // 3 participants * 2 rooms each = 6 total kicks (changing type always kicks everyone)
          expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(6)
        })
      })

      describe('and some participants are not in the new allow list', () => {
        beforeEach(() => {
          // For checking individual access after storing
          worldsManager.getRawWorldRecords.mockResolvedValue(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
          )
        })

        it('should kick all participants (type changed)', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xalice']
          })

          // 3 participants * 2 rooms each = 6 total kicks (changing type always kicks everyone)
          expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(6)
        })
      })

      describe('and no participants are in the new allow list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValue(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xdave'], communities: [] })
          )
        })

        it('should kick all participants from all their rooms', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xdave']
          })

          // 3 participants * 2 rooms each = 6 total kicks
          expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(6)
        })
      })
    })

    describe('and transitioning from Unrestricted to SharedSecret', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        // 2 participants * 2 rooms each = 4 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and transitioning from Unrestricted to NFTOwnership', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.NFTOwnership,
          nft: 'some-nft'
        })

        // 2 participants * 2 rooms each = 4 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and transitioning from SharedSecret to AllowList', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'old-secret' })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.AllowList,
          wallets: ['0xalice']
        })

        // 2 participants * 2 rooms each = 4 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and transitioning from SharedSecret to Unrestricted', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'old-secret' })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should not kick any participants (new type is unrestricted)', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.Unrestricted
        })

        expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
      })
    })

    describe('and transitioning from SharedSecret to NFTOwnership', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'old-secret' })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.NFTOwnership,
          nft: 'some-nft'
        })

        // 1 participant * 2 rooms = 2 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(2)
      })
    })

    describe('and transitioning from AllowList to SharedSecret', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        // 2 participants * 2 rooms each = 4 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and transitioning from AllowList to Unrestricted', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
      })

      it('should not kick any participants (new type is unrestricted)', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.Unrestricted
        })

        expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
      })
    })

    describe('and transitioning from AllowList to NFTOwnership', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
      })

      it('should kick all participants from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.NFTOwnership,
          nft: 'some-nft'
        })

        // 1 participant * 2 rooms = 2 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(2)
      })
    })

    describe('and transitioning from AllowList to AllowList', () => {
      describe('and the wallet list changed (some removed)', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice', '0xbob'], communities: [] })
          )
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
          )
          peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
        })

        it('should not kick any participants (same type)', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xalice']
          })

          expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
        })
      })

      describe('and the wallet list expanded', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
          )
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice', '0xbob'], communities: [] })
          )
          peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
        })

        it('should not kick any participants', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xalice', '0xbob']
          })

          expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
        })
      })

      describe('and the wallet list stayed the same', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
          )
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0xalice'], communities: [] })
          )
          peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
        })

        it('should not kick any participants', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: ['0xalice']
          })

          expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
        })
      })

      describe('and communities are used', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-1'] })
          )
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-2'] })
          )
          peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
          socialService.getMemberCommunities.mockImplementation((ethAddress: string) => {
            if (ethAddress === TEST_SIGNER) {
              return Promise.resolve({ communities: [{ id: 'community-2' }] })
            }
            if (ethAddress === '0xalice') {
              return Promise.resolve({ communities: [{ id: 'community-2' }] })
            }
            return Promise.resolve({ communities: [] })
          })
        })

        it('should not kick any participants (same type)', async () => {
          await accessComponent.setAccess('test-world', TEST_SIGNER, {
            type: AccessType.AllowList,
            wallets: [],
            communities: ['community-2']
          })

          expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
        })
      })
    })

    describe('and transitioning from SharedSecret to SharedSecret', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.SharedSecret, secret: 'old-secret' })
        )
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
      })

      it('should kick all participants when the secret changed', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and transitioning from Unrestricted to Unrestricted', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
      })

      it('should not kick any participants', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.Unrestricted
        })

        expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
      })
    })

    describe('and there are no participants in the world', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue([])
      })

      it('should not attempt to kick anyone', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        expect(commsAdapter.removeParticipant).not.toHaveBeenCalled()
      })
    })

    describe('and kicking participants fails', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob'])
        commsAdapter.removeParticipant = jest.fn().mockRejectedValue(new Error('LiveKit error'))
      })

      it('should still store the access settings', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        expect(worldsManager.storeAccess).toHaveBeenCalled()
      })

      it('should attempt to kick all participants from all rooms despite failures', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        // 2 participants * 2 rooms each = 4 total kick attempts
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(4)
      })
    })

    describe('and checking access fails for some participants', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        worldsManager.getRawWorldRecords.mockImplementation(() => {
          throw new Error('Database error')
        })
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice'])
      })

      it('should kick participants as a precaution', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.AllowList,
          wallets: ['0xalice']
        })

        expect(commsAdapter.removeParticipant).toHaveBeenCalledWith('world-test-world', '0xalice')
      })
    })

    describe('and batching is needed', () => {
      beforeEach(async () => {
        const configWithSmallBatch = createMockedConfig({
          getNumber: jest.fn((key: string) =>
            Promise.resolve(key === 'ACCESS_KICK_BATCH_SIZE' ? 2 : DEFAULT_MAX_WALLETS)
          ),
          requireString: jest.fn((key: string) => Promise.resolve(key === 'COMMS_ROOM_PREFIX' ? 'world-' : 'unknown'))
        })

        const participantKickerWithSmallBatch = await createParticipantKicker({
          peersRegistry,
          commsAdapter,
          logs,
          config: configWithSmallBatch
        })
        const accessCheckerWithSmallBatch = await createAccessCheckerComponent({ worldsManager, socialService })
        const permissionsManagerWithSmallBatch = createMockedPermissionsManager({
          getOwner: jest.fn().mockResolvedValue(undefined),
          getWorldPermissionRecords: jest.fn().mockResolvedValue([])
        })
        const accessChangeHandlerWithSmallBatch = createAccessChangeHandler({
          peersRegistry,
          participantKicker: participantKickerWithSmallBatch,
          logs,
          accessChecker: accessCheckerWithSmallBatch,
          permissionsManager: permissionsManagerWithSmallBatch
        })
        accessComponent = await createAccessComponent({
          config: configWithSmallBatch,
          socialService,
          worldsManager,
          accessChangeHandler: accessChangeHandlerWithSmallBatch,
          accessChecker: accessCheckerWithSmallBatch,
          snsClient
        })

        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
        peersRegistry.getPeersInWorld = jest.fn().mockReturnValue(['0xalice', '0xbob', '0xcharlie', '0xdave', '0xeve'])
      })

      it('should kick participants in batches from all their rooms', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, {
          type: AccessType.SharedSecret,
          secret: 'new-secret'
        })

        // 5 participants * 2 rooms each = 10 total kicks
        expect(commsAdapter.removeParticipant).toHaveBeenCalledTimes(10)
      })
    })
  })
})
