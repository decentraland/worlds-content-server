import { createConfigComponent } from '@well-known-components/env-config-provider'
import { stringToUtf8Bytes } from 'eth-connect'
import { test } from '../components'
import { createWalletStatsComponent } from '../../src/adapters/wallet-stats'
import { WalletStats } from '../../src/types'
import { getIdentity, makeid } from '../utils'

test('WalletStatsAdapter', function ({ components }) {
  describe('when getting the stats of a wallet that owns several worlds', () => {
    let stats: WalletStats
    let expected: Pick<WalletStats, 'dclNames' | 'ensNames' | 'usedSpace'>

    beforeEach(async () => {
      const { database, fetch, logs, worldCreator, worldsManager } = components
      const owner = await getIdentity()

      const deploy = async (worldName: string, base: string, size: number, deployer = owner) => {
        const files = new Map<string, Uint8Array>()
        files.set('abc.txt', stringToUtf8Bytes(makeid(size)))
        await worldCreator.createWorldWithScene({
          worldName,
          metadata: { main: 'abc.txt', scene: { base, parcels: [base] }, worldConfiguration: { name: worldName } },
          files,
          owner: deployer.authChain
        })
      }

      const multiSceneWorld = worldCreator.randomWorldName()
      const undeployedWorld = worldCreator.randomWorldName()
      const ensWorld = `${makeid(10).toLowerCase()}.eth`
      await deploy(multiSceneWorld, '0,0', 100)
      await deploy(multiSceneWorld, '1,1', 200)
      await deploy(undeployedWorld, '0,0', 300)
      await worldsManager.undeployWorld(undeployedWorld)
      await deploy(ensWorld, '0,0', 400)
      await deploy(worldCreator.randomWorldName(), '0,0', 500, await getIdentity())

      // The per-world size query the grouped one replaces is the oracle.
      const sizeOf = async (name: string) => ({ name, size: await worldsManager.getTotalWorldSize(name) })
      const dclNames = (await Promise.all([multiSceneWorld, undeployedWorld].map(sizeOf))).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      expected = {
        dclNames,
        ensNames: [await sizeOf(ensWorld)],
        usedSpace: dclNames.reduce((total, world) => total + world.size, 0n)
      }

      const config = createConfigComponent({})
      const walletStats = await createWalletStatsComponent({ config, database, fetch, logs })
      stats = await walletStats.get(owner.realAccount.address)
    })

    it("should report each owned world's deployed size, as the per-world query does", () => {
      const dclNames = [...stats.dclNames].sort((a, b) => a.name.localeCompare(b.name))
      expect({ dclNames, ensNames: stats.ensNames, usedSpace: stats.usedSpace }).toEqual(expected)
    })

    it('should count an undeployed world with no size', () => {
      expect(expected.dclNames.map((world) => world.size)).toContain(0n)
    })
  })
})
