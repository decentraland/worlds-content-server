import { createAccessCheckerComponent } from '../../src/logic/access-checker'
import { AccessSetting, AccessType } from '../../src/logic/access/types'
import { GetRawWorldRecordsResult, IWorldsManager, WorldRecord } from '../../src/types'
import { ISocialServiceComponent } from '../../src/adapters/social-service'
import { IAccessCheckerComponent } from '../../src/logic/access-checker/types'
import bcrypt from 'bcrypt'

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

describe('AccessCheckerComponent', () => {
  let accessChecker: IAccessCheckerComponent
  let worldsManager: jest.Mocked<IWorldsManager>
  let socialService: jest.Mocked<ISocialServiceComponent>

  beforeEach(async () => {
    worldsManager = {
      getRawWorldRecords: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    socialService = {
      getMemberCommunities: jest.fn().mockResolvedValue({ communities: [] })
    } as unknown as jest.Mocked<ISocialServiceComponent>

    accessChecker = await createAccessCheckerComponent({ worldsManager, socialService })
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
        const result = await accessChecker.checkAccess('test-world', '0x1234')
        expect(result).toBe(true)
      })
    })

    describe('and the world has no metadata', () => {
      beforeEach(() => {
        worldsManager.getRawWorldRecords.mockResolvedValueOnce(mockRawWorldRecords())
      })

      it('should return true (default unrestricted)', async () => {
        const result = await accessChecker.checkAccess('test-world', '0x1234')
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
          const result = await accessChecker.checkAccess('test-world', '0x1234', 'my-secret')
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
          const result = await accessChecker.checkAccess('test-world', '0x1234', 'wrong-secret')
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
          const result = await accessChecker.checkAccess('test-world', '0x1234')
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
          const result = await accessChecker.checkAccess('test-world', '0xabcd')
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
          const result = await accessChecker.checkAccess('test-world', '0x5678')
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
            const result = await accessChecker.checkAccess('test-world', '0x5678')
            expect(result).toBe(true)
          })

          it('should check communities using the batch endpoint', async () => {
            await accessChecker.checkAccess('test-world', '0x5678')
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
            const result = await accessChecker.checkAccess('test-world', '0x1234')

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
            const result = await accessChecker.checkAccess('test-world', '0x5678')
            expect(result).toBe(true)
          })

          it('should check all communities in a single batch request', async () => {
            await accessChecker.checkAccess('test-world', '0x5678')
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
            const result = await accessChecker.checkAccess('test-world', '0x5678')
            expect(result).toBe(false)
          })
        })

        describe('and the social service returns an error (fail closed)', () => {
          beforeEach(() => {
            worldsManager.getRawWorldRecords.mockResolvedValueOnce(
              mockRawWorldRecords({ type: AccessType.AllowList, wallets: [], communities: ['community-1'] })
            )
            socialService.getMemberCommunities.mockResolvedValueOnce({ communities: [] })
          })

          it('should return false (deny access)', async () => {
            const result = await accessChecker.checkAccess('test-world', '0x5678')
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
        const result = await accessChecker.checkAccess('test-world', '0x1234')
        expect(result).toBe(false)
      })
    })
  })
})
