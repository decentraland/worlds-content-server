import { createAccessComponent } from '../../src/logic/access/component'
import { AccessSetting, AccessType, IAccessComponent } from '../../src/logic/access/types'
import {
  InvalidAccessTypeError,
  NotAllowListAccessError,
  UnauthorizedCommunityError
} from '../../src/logic/access/errors'
import { MAX_COMMUNITIES } from '../../src/logic/access/constants'
import { GetRawWorldRecordsResult, IWorldsManager, WorldRecord } from '../../src/types'
import { ISocialServiceComponent } from '../../src/adapters/social-service'
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

  beforeEach(() => {
    worldsManager = {
      getRawWorldRecords: jest.fn(),
      storeAccess: jest.fn(),
      createBasicWorldIfNotExists: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    socialService = {
      getMemberCommunities: jest.fn().mockResolvedValue({ communities: [] })
    } as unknown as jest.Mocked<ISocialServiceComponent>

    accessComponent = createAccessComponent({ socialService, worldsManager })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking access', () => {
    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords({ type: AccessType.Unrestricted }))
      })

      it('should return true for any address', async () => {
        const result = await accessComponent.checkAccess('test-world', '0x1234')
        expect(result).toBe(true)
      })
    })

    describe('and the world has no metadata', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords())
      })

      it('should return true (default unrestricted)', async () => {
        const result = await accessComponent.checkAccess('test-world', '0x1234')
        expect(result).toBe(true)
      })
    })

    describe('and the world has shared-secret access', () => {
      let hashedSecret: string

      beforeEach(() => {
        hashedSecret = bcrypt.hashSync('my-secret', 10)
      })

      describe('and the correct secret is provided', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.SharedSecret, secret: hashedSecret })
          )
        })

        it('should return true', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x1234', 'my-secret')
          expect(result).toBe(true)
        })
      })

      describe('and an incorrect secret is provided', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.SharedSecret, secret: hashedSecret })
          )
        })

        it('should return false', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x1234', 'wrong-secret')
          expect(result).toBe(false)
        })
      })
    })

    describe('and the world has allow-list access', () => {
      describe('and the address is in the allow list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'], communities: [] })
          )
        })

        it('should return true', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x1234')
          expect(result).toBe(true)
        })
      })

      describe('and the address is in the allow list with different case', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'], communities: [] })
          )
        })

        it('should return true (case insensitive)', async () => {
          const result = await accessComponent.checkAccess('test-world', '0xabcd')
          expect(result).toBe(true)
        })
      })

      describe('and the address is not in the allow list', () => {
        beforeEach(() => {
          worldsManager.getRawWorldRecords.mockResolvedValueOnce(
            mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'], communities: [] })
          )
        })

        it('should return false', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x5678')
          expect(result).toBe(false)
        })
      })

      describe('and the world has communities configured', () => {
        describe('and the address is not in the wallet allow list but is a community member', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({
                type: AccessType.AllowList,
                wallets: ['0x1234'],
                communities: ['community-1', 'community-2']
              })
            )
            socialService.getMemberCommunities.mockResolvedValueOnce({ communities: [{ id: 'community-1' }] })
          })

          it('should return true', async () => {
            const result = await accessComponent.checkAccess('test-world', '0x5678')
            expect(result).toBe(true)
          })

          it('should check communities using the batch endpoint', async () => {
            await accessComponent.checkAccess('test-world', '0x5678')
            expect(socialService.getMemberCommunities).toHaveBeenCalledWith('0x5678', ['community-1', 'community-2'])
          })
        })

        describe('and the address is in the wallet allow list', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({ type: AccessType.AllowList, wallets: ['0x1234'], communities: ['community-1'] })
            )
          })

          it('should return true without checking communities (wallet check is faster)', async () => {
            const result = await accessComponent.checkAccess('test-world', '0x1234')

            expect(result).toBe(true)
            expect(socialService.getMemberCommunities).not.toHaveBeenCalled()
          })
        })

        describe('and the address is a member of multiple communities', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({
                type: AccessType.AllowList,
                wallets: [],
                communities: ['community-1', 'community-2']
              })
            )
            socialService.getMemberCommunities.mockResolvedValueOnce({
              communities: [{ id: 'community-2' }]
            })
          })

          it('should return true when member of any community', async () => {
            const result = await accessComponent.checkAccess('test-world', '0x5678')
            expect(result).toBe(true)
          })

          it('should check all communities in a single batch request', async () => {
            await accessComponent.checkAccess('test-world', '0x5678')
            expect(socialService.getMemberCommunities).toHaveBeenCalledTimes(1)
            expect(socialService.getMemberCommunities).toHaveBeenCalledWith('0x5678', ['community-1', 'community-2'])
          })
        })

        describe('and the address is not a member of any community', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({
                type: AccessType.AllowList,
                wallets: [],
                communities: ['community-1', 'community-2']
              })
            )
            socialService.getMemberCommunities.mockResolvedValueOnce({ communities: [] })
          })

          it('should return false when not a member of any community', async () => {
            const result = await accessComponent.checkAccess('test-world', '0x5678')
            expect(result).toBe(false)
          })
        })

        describe('and the social service returns an error (fail closed)', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-1'] })
            )
            // Social service adapter already fails closed by returning empty communities on error
            socialService.getMemberCommunities.mockResolvedValueOnce({ communities: [] })
          })

          it('should return false (deny access)', async () => {
            const result = await accessComponent.checkAccess('test-world', '0x5678')
            expect(result).toBe(false)
          })
        })
      })
    })

    describe('and the world has nft-ownership access', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(
          mockRawWorldRecords({ type: AccessType.NFTOwnership, nft: 'some-nft' })
        )
      })

      it('should return false (not yet implemented)', async () => {
        const result = await accessComponent.checkAccess('test-world', '0x1234')
        expect(result).toBe(false)
      })
    })
  })

  describe('when setting access', () => {
    describe('and setting unrestricted access', () => {
      it('should store unrestricted access setting', async () => {
        await accessComponent.setAccess('test-world', TEST_SIGNER, { type: AccessType.Unrestricted })

        expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
          type: AccessType.Unrestricted
        })
      })
    })

    describe('and setting allow-list access', () => {
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
          tooManyCommunities = Array.from({ length: MAX_COMMUNITIES + 1 }, (_, i) => `community-${i}`)
        })

        it('should throw InvalidAccessTypeError', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: tooManyCommunities
            })
          ).rejects.toThrow(InvalidAccessTypeError)
        })

        it('should include the limit in the error message', async () => {
          await expect(
            accessComponent.setAccess('test-world', TEST_SIGNER, {
              type: AccessType.AllowList,
              wallets: ['0x1234'],
              communities: tooManyCommunities
            })
          ).rejects.toThrow(`Maximum allowed is ${MAX_COMMUNITIES}`)
        })
      })

      describe('and communities are at the maximum limit', () => {
        let maxCommunities: string[]

        beforeEach(() => {
          maxCommunities = Array.from({ length: MAX_COMMUNITIES }, (_, i) => `community-${i}`)
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
      it('should throw InvalidAccessTypeError', async () => {
        await expect(accessComponent.setAccess('test-world', TEST_SIGNER, { type: 'invalid-type' })).rejects.toThrow(
          InvalidAccessTypeError
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
})
