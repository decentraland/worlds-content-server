import { createLimitsManagerComponent } from '../../src/adapters/limits-manager'
import { loadUploadLimits } from '../../src/logic/upload-limits'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { createMockWhitelistComponent } from '../mocks/whitelist-mock'
import { createMockedWorldsManager } from '../mocks/worlds-manager-mock'
import { EthAddress } from '@dcl/schemas'
import {
  ILimitsManager,
  INameOwnership,
  IWalletStats,
  IWorldsManager,
  MB_BigInt,
  WalletStats,
  Whitelist
} from '../../src/types'
import { IWhitelistComponent } from '../../src/adapters/whitelist'
import { IConfigComponent } from '@well-known-components/interfaces'

describe('limits manager', function () {
  let config: IConfigComponent
  let nameOwnership: jest.Mocked<INameOwnership>
  let walletStats: IWalletStats
  let whitelist: IWhitelistComponent
  let worldsManager: jest.Mocked<IWorldsManager>
  let limitsManager: ILimitsManager

  beforeEach(async () => {
    config = createConfigComponent({
      MAX_PARCELS: '4',
      MAX_SIZE: '200',
      ENS_MAX_SIZE: '36',
      ALLOW_SDK6: 'false'
    })
    whitelist = createMockWhitelistComponent({
      'purchased.dcl.eth': {
        max_parcels: 44,
        max_size_in_mb: 160,
        allow_sdk6: true
      }
    })
    nameOwnership = createMockedNameOwnership()
    nameOwnership.findOwners.mockImplementation(async (worldNames: string[]) => {
      const owners = new Map([['whatever.dcl.eth', '0x123']])
      const result = new Map<string, string | undefined>()
      worldNames.forEach((name) => result.set(name, owners.get(name)))
      return result
    })
    walletStats = createMockWalletStatsComponent(
      new Map<EthAddress, WalletStats>([
        [
          '0x123',
          {
            wallet: '0x123',
            dclNames: [{ name: 'whatever.dcl.eth', size: 10n }],
            ensNames: [],
            usedSpace: 10n,
            maxAllowedSpace: 200n * MB_BigInt
          }
        ]
      ])
    )
    worldsManager = createMockedWorldsManager()
    limitsManager = await createLimitsManagerComponent({
      config,
      uploadLimits: await loadUploadLimits(config),
      nameOwnership,
      walletStats,
      whitelist,
      worldsManager
    })
  })

  it('fetches whitelist and responds for whitelisted names', async () => {
    expect(await limitsManager.getAllowSdk6For('purchased.dcl.eth')).toBeTruthy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('purchased.dcl.eth')).toBe(160n * MB_BigInt)
    expect(await limitsManager.getMaxAllowedParcelsFor('purchased.dcl.eth')).toBe(44)
  })

  it('responds for ENS names', async () => {
    expect(await limitsManager.getAllowSdk6For('cool.eth')).toBeFalsy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('cool.eth')).toBe(36n * MB_BigInt)
    expect(await limitsManager.getMaxAllowedParcelsFor('cool.eth')).toBe(4)
  })

  it('fails to respond size when owner can not be determined', async () => {
    expect(await limitsManager.getAllowSdk6For('no-owner.dcl.eth')).toBeFalsy()
    await expect(limitsManager.getMaxAllowedSizeInBytesFor('no-owner.dcl.eth')).rejects.toThrowError(
      'Could not determine owner for world no-owner.dcl.eth'
    )
    expect(await limitsManager.getMaxAllowedParcelsFor('no-owner.dcl.eth')).toBe(4)
  })

  it('responds for DCL names that relay on wallet stats from external service', async () => {
    expect(await limitsManager.getAllowSdk6For('whatever.dcl.eth')).toBeFalsy()
    expect(await limitsManager.getMaxAllowedSizeInBytesFor('whatever.dcl.eth')).toBe(200n * MB_BigInt)
    expect(await limitsManager.getMaxAllowedParcelsFor('whatever.dcl.eth')).toBe(4)
  })

  describe('when a whitelisted world name arrives in mixed case', () => {
    const worldName = 'Purchased.dcl.eth'
    let maxSize: bigint
    let maxParcels: number
    let allowSdk6: boolean

    beforeEach(async () => {
      maxSize = await limitsManager.getMaxAllowedSizeInBytesFor(worldName)
      maxParcels = await limitsManager.getMaxAllowedParcelsFor(worldName)
      allowSdk6 = await limitsManager.getAllowSdk6For(worldName)
    })

    it('should return the whitelisted size', () => {
      expect(maxSize).toBe(160n * MB_BigInt)
    })

    it('should return the whitelisted parcels', () => {
      expect(maxParcels).toBe(44)
    })

    it('should return the whitelisted sdk6 permission', () => {
      expect(allowSdk6).toBe(true)
    })
  })

  describe('when the whitelist source is unavailable', () => {
    beforeEach(async () => {
      const failingWhitelist: IWhitelistComponent = {
        get: jest.fn().mockRejectedValue(new Error('whitelist down'))
      }
      limitsManager = await createLimitsManagerComponent({
        config,
        uploadLimits: await loadUploadLimits(config),
        nameOwnership,
        walletStats,
        whitelist: failingWhitelist,
        worldsManager
      })
    })

    it('should fall back to the hard limits instead of failing', async () => {
      expect(await limitsManager.getMaxAllowedParcelsFor('purchased.dcl.eth')).toBe(4)
      expect(await limitsManager.getAllowSdk6For('purchased.dcl.eth')).toBe(false)
    })
  })

  describe('when computing the size limit for a deployment targeting specific parcels', () => {
    beforeEach(() => {
      // The world has 10 bytes deployed in total, but only 4 bytes sit on the parcels
      // this deployment overlaps and will replace.
      worldsManager.getDeployedSceneSizeForParcels.mockResolvedValue(4n)
    })

    it('should credit back only the size of the overlapping scenes, not the whole world', async () => {
      // maxAllowedSpace - (usedSpace - overlappingSize) = 200MB - (10 - 4) = 200MB - 6
      expect(await limitsManager.getMaxAllowedSizeInBytesFor('whatever.dcl.eth', ['1,0'])).toBe(200n * MB_BigInt - 6n)
    })

    it('should query the deployed scene size for the deployment parcels', async () => {
      await limitsManager.getMaxAllowedSizeInBytesFor('whatever.dcl.eth', ['1,0'])

      expect(worldsManager.getDeployedSceneSizeForParcels).toHaveBeenCalledWith('whatever.dcl.eth', ['1,0'])
    })
  })

  it('uses the hard size limit when name ownership validation is explicitly ignored', async () => {
    config = createConfigComponent({
      MAX_PARCELS: '4',
      MAX_SIZE: '200',
      ENS_MAX_SIZE: '36',
      ALLOW_SDK6: 'false',
      IGNORE_NAME_OWNERSHIP_VALIDATION: 'true'
    })
    limitsManager = await createLimitsManagerComponent({
      config,
      uploadLimits: await loadUploadLimits(config),
      nameOwnership,
      walletStats,
      whitelist,
      worldsManager
    })

    nameOwnership.findOwners.mockResolvedValue(new Map())

    await expect(limitsManager.getMaxAllowedSizeInBytesFor('any-name.dcl.eth')).resolves.toBe(200n * MB_BigInt)
    expect(nameOwnership.findOwners).not.toHaveBeenCalled()
  })
})

describe('when computing the per-scene size limit', () => {
  const owner = '0xowner'
  let configValues: Record<string, string>
  let whitelistEntries: Whitelist
  let maxAllowedSpace: bigint
  let nameOwnership: jest.Mocked<INameOwnership>
  let worldName: string
  let result: bigint

  async function build(): Promise<ILimitsManager> {
    nameOwnership = createMockedNameOwnership()
    nameOwnership.findOwners.mockResolvedValue(new Map([[worldName, owner]]))
    return createLimitsManagerComponent({
      config: createConfigComponent(configValues),
      uploadLimits: await loadUploadLimits(createConfigComponent(configValues)),
      nameOwnership,
      walletStats: createMockWalletStatsComponent(
        new Map<EthAddress, WalletStats>([
          [owner, { wallet: owner, dclNames: [], ensNames: [], usedSpace: 0n, maxAllowedSpace }]
        ])
      ),
      whitelist: createMockWhitelistComponent(whitelistEntries),
      worldsManager: createMockedWorldsManager()
    })
  }

  beforeEach(() => {
    configValues = { MAX_PARCELS: '4', MAX_SIZE: '200', ENS_MAX_SIZE: '36', ALLOW_SDK6: 'false', MAX_SCENE_SIZE: '150' }
    whitelistEntries = {}
    maxAllowedSpace = 100n * MB_BigInt
    worldName = 'owned.dcl.eth'
  })

  describe('and the world is a DCL name whose owner has less remaining allowance than the cap', () => {
    beforeEach(async () => {
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return the remaining allowance', () => {
      expect(result).toBe(100n * MB_BigInt)
    })
  })

  describe('and the world is a DCL name whose owner has more remaining allowance than the cap', () => {
    beforeEach(async () => {
      maxAllowedSpace = 800n * MB_BigInt
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return the cap', () => {
      expect(result).toBe(150n * MB_BigInt)
    })
  })

  describe('and the cap is not configured', () => {
    beforeEach(async () => {
      delete configValues.MAX_SCENE_SIZE
      maxAllowedSpace = 800n * MB_BigInt
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should cap at the default of 500 MiB', () => {
      expect(result).toBe(500n * MB_BigInt)
    })
  })

  describe('and the world is whitelisted with a size above the cap', () => {
    beforeEach(async () => {
      whitelistEntries = { [worldName]: { max_size_in_mb: 300 } }
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return the whitelisted size', () => {
      expect(result).toBe(300n * MB_BigInt)
    })
  })

  describe('and the world is whitelisted without a size', () => {
    beforeEach(async () => {
      whitelistEntries = { [worldName]: { max_parcels: 10 } }
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return MAX_SIZE', () => {
      expect(result).toBe(200n * MB_BigInt)
    })
  })

  describe('and the world is an ENS name', () => {
    beforeEach(async () => {
      worldName = 'cool.eth'
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return ENS_MAX_SIZE', () => {
      expect(result).toBe(36n * MB_BigInt)
    })
  })

  describe('and the world is an ENS name in mixed case', () => {
    beforeEach(async () => {
      worldName = 'Cool.ETH'
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return ENS_MAX_SIZE', () => {
      expect(result).toBe(36n * MB_BigInt)
    })
  })

  describe('and the world is a DCL name with a mixed-case suffix', () => {
    beforeEach(async () => {
      worldName = 'Owned.DCL.eth'
      const limitsManager = await build()
      nameOwnership.findOwners.mockResolvedValue(new Map([['owned.dcl.eth', owner]]))
      result = await limitsManager.getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return the owner remaining allowance instead of ENS_MAX_SIZE', () => {
      expect(result).toBe(100n * MB_BigInt)
    })
  })

  describe('and name ownership validation is ignored', () => {
    beforeEach(async () => {
      configValues.IGNORE_NAME_OWNERSHIP_VALIDATION = 'true'
      result = await (await build()).getMaxAllowedSizeInBytesFor(worldName)
    })

    it('should return MAX_SIZE', () => {
      expect(result).toBe(200n * MB_BigInt)
    })
  })
})

describe("when computing a world's stable scene size cap", () => {
  let configValues: Record<string, string>
  let whitelistEntries: Whitelist
  let nameOwnership: jest.Mocked<INameOwnership>
  let walletStats: jest.Mocked<IWalletStats>
  let worldsManager: jest.Mocked<IWorldsManager>
  let result: bigint

  async function capFor(worldName: string): Promise<bigint> {
    const limitsManager = await createLimitsManagerComponent({
      config: createConfigComponent(configValues),
      uploadLimits: await loadUploadLimits(createConfigComponent(configValues)),
      nameOwnership,
      walletStats,
      whitelist: createMockWhitelistComponent(whitelistEntries),
      worldsManager
    })
    return limitsManager.getSceneSizeCapInBytesFor(worldName)
  }

  beforeEach(() => {
    configValues = { MAX_PARCELS: '4', MAX_SIZE: '200', ENS_MAX_SIZE: '36', ALLOW_SDK6: 'false', MAX_SCENE_SIZE: '150' }
    whitelistEntries = {}
    nameOwnership = createMockedNameOwnership()
    walletStats = { get: jest.fn() }
    worldsManager = createMockedWorldsManager()
  })

  describe('and the world is a DCL name', () => {
    beforeEach(async () => {
      result = await capFor('owned.dcl.eth')
    })

    it('should return MAX_SCENE_SIZE', () => {
      expect(result).toBe(150n * MB_BigInt)
    })

    it("should not look up the owner, its wallet or the deployed parcels' sizes", () => {
      expect({
        owners: nameOwnership.findOwners.mock.calls.length,
        wallets: walletStats.get.mock.calls.length,
        parcels: worldsManager.getDeployedSceneSizeForParcels.mock.calls.length
      }).toEqual({ owners: 0, wallets: 0, parcels: 0 })
    })
  })

  describe('and the world is whitelisted with a size', () => {
    beforeEach(async () => {
      whitelistEntries = { 'owned.dcl.eth': { max_size_in_mb: 300 } }
      result = await capFor('Owned.dcl.eth')
    })

    it('should return the whitelisted size for the lowercased name', () => {
      expect(result).toBe(300n * MB_BigInt)
    })
  })

  describe('and the world is whitelisted without a size', () => {
    beforeEach(async () => {
      whitelistEntries = { 'owned.dcl.eth': { max_parcels: 10 } }
      result = await capFor('owned.dcl.eth')
    })

    it('should return MAX_SIZE', () => {
      expect(result).toBe(200n * MB_BigInt)
    })
  })

  describe('and the world is an ENS name in mixed case', () => {
    beforeEach(async () => {
      result = await capFor('Cool.ETH')
    })

    it('should return ENS_MAX_SIZE', () => {
      expect(result).toBe(36n * MB_BigInt)
    })
  })

  describe('and name ownership validation is ignored', () => {
    beforeEach(async () => {
      configValues.IGNORE_NAME_OWNERSHIP_VALIDATION = 'true'
      result = await capFor('owned.dcl.eth')
    })

    it('should return MAX_SIZE', () => {
      expect(result).toBe(200n * MB_BigInt)
    })
  })
})
