import { createLimitsManagerComponent } from '../../src/adapters/limits-manager'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { createMockedWorldsManager } from '../mocks/worlds-manager-mock'
import { EthAddress } from '@dcl/schemas'
import { ILimitsManager, INameOwnership, IWalletStats, IWorldsManager, MB_BigInt, WalletStats } from '../../src/types'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IFetchComponent } from '@dcl/core-commons'

describe('limits manager', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent
  let fetch: IFetchComponent
  let nameOwnership: jest.Mocked<INameOwnership>
  let walletStats: IWalletStats
  let worldsManager: jest.Mocked<IWorldsManager>
  let limitsManager: ILimitsManager

  beforeEach(async () => {
    logs = await createLogComponent({})
    config = createConfigComponent({
      MAX_PARCELS: '4',
      MAX_SIZE: '200',
      ENS_MAX_SIZE: '36',
      ALLOW_SDK6: 'false',
      WHITELIST_URL: 'http://localhost/whitelist.json'
    })
    fetch = {
      fetch: async (_url: Request): Promise<Response> =>
        new Response(
          JSON.stringify({
            'purchased.dcl.eth': {
              max_parcels: 44,
              max_size_in_mb: 160,
              allow_sdk6: true
            }
          })
        )
    }
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
      fetch,
      logs,
      nameOwnership,
      walletStats,
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
})
