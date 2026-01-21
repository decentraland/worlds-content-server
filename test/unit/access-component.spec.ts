import { createAccessComponent } from '../../src/logic/access/component'
import { AccessType, IAccessComponent } from '../../src/logic/access/types'
import { InvalidAccessTypeError } from '../../src/logic/access/errors'
import { IWorldsManager, WorldMetadata } from '../../src/types'
import bcrypt from 'bcrypt'

describe('AccessComponent', () => {
  let accessComponent: IAccessComponent
  let worldsManager: jest.Mocked<IWorldsManager>

  beforeEach(() => {
    worldsManager = {
      getMetadataForWorld: jest.fn(),
      storeAccess: jest.fn()
    } as unknown as jest.Mocked<IWorldsManager>

    accessComponent = createAccessComponent({ worldsManager })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking access', () => {
    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getMetadataForWorld.mockResolvedValueOnce({
          access: { type: AccessType.Unrestricted }
        } as WorldMetadata)
      })

      it('should return true for any address', async () => {
        const result = await accessComponent.checkAccess('test-world', '0x1234')
        expect(result).toBe(true)
      })
    })

    describe('and the world has no metadata', () => {
      beforeEach(() => {
        worldsManager.getMetadataForWorld.mockResolvedValueOnce(undefined)
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
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.SharedSecret, secret: hashedSecret }
          } as WorldMetadata)
        })

        it('should return true', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x1234', 'my-secret')
          expect(result).toBe(true)
        })
      })

      describe('and an incorrect secret is provided', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.SharedSecret, secret: hashedSecret }
          } as WorldMetadata)
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
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'] }
          } as WorldMetadata)
        })

        it('should return true', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x1234')
          expect(result).toBe(true)
        })
      })

      describe('and the address is in the allow list with different case', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'] }
          } as WorldMetadata)
        })

        it('should return true (case insensitive)', async () => {
          const result = await accessComponent.checkAccess('test-world', '0xabcd')
          expect(result).toBe(true)
        })
      })

      describe('and the address is not in the allow list', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'] }
          } as WorldMetadata)
        })

        it('should return false', async () => {
          const result = await accessComponent.checkAccess('test-world', '0x5678')
          expect(result).toBe(false)
        })
      })
    })

    describe('and the world has nft-ownership access', () => {
      beforeEach(() => {
        worldsManager.getMetadataForWorld.mockResolvedValueOnce({
          access: { type: AccessType.NFTOwnership, nft: 'some-nft' }
        } as WorldMetadata)
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
        await accessComponent.setAccess('test-world', { type: AccessType.Unrestricted })

        expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
          type: AccessType.Unrestricted
        })
      })
    })

    describe('and setting allow-list access', () => {
      describe('and wallets are provided', () => {
        it('should store allow-list access setting with wallets', async () => {
          await accessComponent.setAccess('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678']
          })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: ['0x1234', '0x5678']
          })
        })
      })

      describe('and wallets are not provided', () => {
        it('should store allow-list access setting with empty wallets', async () => {
          await accessComponent.setAccess('test-world', { type: AccessType.AllowList })

          expect(worldsManager.storeAccess).toHaveBeenCalledWith('test-world', {
            type: AccessType.AllowList,
            wallets: []
          })
        })
      })
    })

    describe('and setting shared-secret access', () => {
      describe('and a secret is provided', () => {
        let storedAccess: any

        beforeEach(async () => {
          await accessComponent.setAccess('test-world', {
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
          await expect(accessComponent.setAccess('test-world', { type: AccessType.SharedSecret })).rejects.toThrow(
            InvalidAccessTypeError
          )
        })
      })
    })

    describe('and setting nft-ownership access', () => {
      describe('and an nft is provided', () => {
        it('should store nft access setting', async () => {
          await accessComponent.setAccess('test-world', {
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
          await expect(accessComponent.setAccess('test-world', { type: AccessType.NFTOwnership })).rejects.toThrow(
            InvalidAccessTypeError
          )
        })
      })
    })

    describe('and setting an invalid access type', () => {
      it('should throw InvalidAccessTypeError', async () => {
        await expect(accessComponent.setAccess('test-world', { type: 'invalid-type' })).rejects.toThrow(
          InvalidAccessTypeError
        )
      })
    })
  })

  describe('when getting address access permission', () => {
    describe('and the world has allow-list access', () => {
      describe('and the address is in the list', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'] }
          } as WorldMetadata)
        })

        it('should return the address info', async () => {
          const result = await accessComponent.getAddressAccessPermission('test-world', '0x1234')

          expect(result).toEqual({
            worldName: 'test-world',
            address: '0x1234'
          })
        })
      })

      describe('and the address is in the list with different case', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234', '0xABCD'] }
          } as WorldMetadata)
        })

        it('should return the address info with lowercase address', async () => {
          const result = await accessComponent.getAddressAccessPermission('test-world', '0xAbCd')

          expect(result).toEqual({
            worldName: 'test-world',
            address: '0xabcd'
          })
        })
      })

      describe('and the address is not in the list', () => {
        beforeEach(() => {
          worldsManager.getMetadataForWorld.mockResolvedValueOnce({
            access: { type: AccessType.AllowList, wallets: ['0x1234'] }
          } as WorldMetadata)
        })

        it('should return null', async () => {
          const result = await accessComponent.getAddressAccessPermission('test-world', '0x5678')
          expect(result).toBeNull()
        })
      })
    })

    describe('and the world has unrestricted access', () => {
      beforeEach(() => {
        worldsManager.getMetadataForWorld.mockResolvedValueOnce({
          access: { type: AccessType.Unrestricted }
        } as WorldMetadata)
      })

      it('should return null', async () => {
        const result = await accessComponent.getAddressAccessPermission('test-world', '0x1234')
        expect(result).toBeNull()
      })
    })

    describe('and the world has no metadata', () => {
      beforeEach(() => {
        worldsManager.getMetadataForWorld.mockResolvedValueOnce(undefined)
      })

      it('should return null', async () => {
        const result = await accessComponent.getAddressAccessPermission('test-world', '0x1234')
        expect(result).toBeNull()
      })
    })
  })
})
