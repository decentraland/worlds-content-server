import { test } from '../components'
import { createLimitsManagerComponent } from '../../src/adapters/limits-manager'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockWalletStatsComponent } from '../mocks/wallet-stats-mock'
import { stringToUtf8Bytes } from 'eth-connect'
import { makeid } from '../utils'
import { EthAddress } from '@dcl/schemas'
import { ILimitsManager, MB_BigInt, WalletStats } from '../../src/types'
import { IFetchComponent } from '@dcl/core-commons'

test('LimitsManagerAdapter', function ({ components }) {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when computing the max allowed size for a deployment to a multi-scene world', () => {
    const owner: EthAddress = '0x1234567890123456789012345678901234567890'
    const maxAllowedSpace = 200n * MB_BigInt
    let limitsManager: ILimitsManager
    let worldName: string
    let firstSceneSize: bigint
    let secondSceneSize: bigint

    beforeEach(async () => {
      const { worldCreator, worldsManager, logs } = components

      worldName = worldCreator.randomWorldName()

      // Two non-overlapping scenes of different sizes, deployed to the real DB
      const filesA = new Map<string, Uint8Array>()
      filesA.set('abc.txt', stringToUtf8Bytes(makeid(100)))
      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels: ['0,0'] },
          worldConfiguration: { name: worldName }
        },
        files: filesA
      })

      const filesB = new Map<string, Uint8Array>()
      filesB.set('abc.txt', stringToUtf8Bytes(makeid(200)))
      await worldCreator.createWorldWithScene({
        worldName,
        metadata: {
          main: 'abc.txt',
          scene: { base: '1,1', parcels: ['1,1'] },
          worldConfiguration: { name: worldName }
        },
        files: filesB
      })

      const { scenes } = await worldsManager.getWorldScenes({ worldName })
      firstSceneSize = scenes.find((scene) => scene.parcels.includes('0,0'))!.size
      secondSceneSize = scenes.find((scene) => scene.parcels.includes('1,1'))!.size

      // Only the external pieces (account holdings and name ownership) are mocked; the real
      // limits-manager runs against the real worldsManager and DB.
      const config = createConfigComponent({
        MAX_PARCELS: '4',
        MAX_SIZE: '100',
        ENS_MAX_SIZE: '36',
        ALLOW_SDK6: 'false',
        WHITELIST_URL: 'http://localhost/whitelist.json'
      })
      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(JSON.stringify({}))
      }
      const nameOwnership = createMockedNameOwnership()
      nameOwnership.findOwners.mockResolvedValue(new Map([[worldName, owner]]))
      const walletStats = createMockWalletStatsComponent(
        new Map<EthAddress, WalletStats>([
          [
            owner,
            {
              wallet: owner,
              dclNames: [{ name: worldName, size: firstSceneSize + secondSceneSize }],
              ensNames: [],
              usedSpace: firstSceneSize + secondSceneSize,
              maxAllowedSpace
            }
          ]
        ])
      )

      limitsManager = await createLimitsManagerComponent({
        config,
        fetch,
        logs,
        nameOwnership,
        walletStats,
        worldsManager
      })
    })

    describe('and the deployment overlaps one of the existing scenes', () => {
      it('should credit back only the size of the overlapping scene', async () => {
        // Redeploying onto 1,1 replaces only the second scene, so only its size is freed:
        // remaining = maxAllowedSpace - (usedSpace - secondSceneSize) = maxAllowedSpace - firstSceneSize.
        const remaining = await limitsManager.getMaxAllowedSizeInBytesFor(worldName, ['1,1'])

        expect(remaining).toBe(maxAllowedSpace - firstSceneSize)
      })
    })

    describe('and the deployment does not overlap any existing scene', () => {
      it('should not credit back any size', async () => {
        const remaining = await limitsManager.getMaxAllowedSizeInBytesFor(worldName, ['5,5'])

        expect(remaining).toBe(maxAllowedSpace - (firstSceneSize + secondSceneSize))
      })
    })
  })
})
