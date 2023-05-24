import { AppComponents, IEngagementStats, IEngagementStatsFetcher } from '../types'
import { EthAddress } from '@dcl/schemas'
import { balanceOf, getOwnerOf } from '../contracts'
import { Network } from '../contracts/types'

type WorldStats = {
  owner: EthAddress
  ownedLands: number
  activeRentals: number
}

export async function createEngagementStatsFetcherComponent({
  logs,
  config,
  jsonRpcProvider
}: Pick<AppComponents, 'config' | 'jsonRpcProvider' | 'logs'>): Promise<IEngagementStatsFetcher> {
  const logger = logs.getLogger('engagement-stats-fetcher')
  const networkId = await config.requireString('NETWORK_ID')
  const networkName: Network = networkId === '1' ? 'mainnet' : 'goerli'

  return {
    async for(worldNames: string[]): Promise<IEngagementStats> {
      // First figure out the owners for all the names
      const owners = new Map<string, EthAddress>()
      const walletsStats = new Map<EthAddress, WorldStats>()
      await Promise.all(
        worldNames.map(async (worldName: string) => {
          try {
            const ownerOf = await getOwnerOf(worldName.replace('.dcl.eth', ''), networkName, jsonRpcProvider)
            owners.set(worldName, ownerOf.toLowerCase())
            walletsStats.set(ownerOf.toLowerCase(), { owner: ownerOf.toLowerCase(), ownedLands: 0, activeRentals: 0 })
            logger.info(`Adding owner of world ${worldName}: ${ownerOf.toLowerCase()}`)
          } catch (error: any) {
            logger.warn(`Error fetching owner of world ${worldName}: ${error.message}`)
          }
        })
      )

      // Fetch balanceOf from LAND contract for each owner
      await Promise.all(
        Array.from(walletsStats.values()).map(async (walletStats: WorldStats) => {
          try {
            walletStats.ownedLands = await balanceOf(walletStats.owner, networkName, jsonRpcProvider)
            logger.info(`Adding balanceOf for ${walletStats.owner}: ${walletStats.ownedLands}`)
          } catch (e: any) {
            console.warn(`Error fetching balanceOf for ${walletStats.owner}: ${e.message}`)
          }
        })
      )

      // Fetch the active rental contracts for each owner
      for (const [_, walletStats] of walletsStats) {
        // TODO: Fetch active rental contracts for each owner
        const activeRentals = 0
        walletStats.activeRentals = activeRentals
      }

      return {
        shouldBeIndexed(worldName: string): boolean {
          const wallet = owners.get(worldName)
          if (wallet) {
            const worldStats = walletsStats.get(wallet)!
            const result = !!worldStats && (worldStats.ownedLands > 0 || worldStats.activeRentals > 0)
            logger.info(
              `for ${worldName}: ownedLands: ${worldStats.ownedLands}, activeRentals: ${worldStats.activeRentals}, shouldBeIndexed: ${result} `
            )
            return result
          }

          return false
        }
      }
    }
  }
}
