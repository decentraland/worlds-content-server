import { AppComponents, IEngagementStats, IEngagementStatsFetcher } from '../types'
import { EthAddress } from '@dcl/schemas'
import { getOwnerOf } from '../contracts'
import { Network } from '../contracts/types'

type WorldStats = {
  owner: EthAddress
  ownedLands: number
  activeRentals: number
}

export async function createEngagementStatsFetcherComponent({
  config,
  jsonRpcProvider
}: Pick<AppComponents, 'config' | 'jsonRpcProvider'>): Promise<IEngagementStatsFetcher> {
  const networkId = await config.requireString('NETWORK_ID')
  const networkName: Network = networkId === '1' ? 'mainnet' : 'goerli'

  return {
    async for(worldNames: string[]): Promise<IEngagementStats> {
      // First figure out the owners for all the names
      const owners = new Map<string, EthAddress>()
      const walletsStats = new Map<EthAddress, WorldStats>()
      for (const worldName of worldNames) {
        try {
          const ownerOf = await getOwnerOf(worldName.replace('.dcl.eth', ''), networkName, jsonRpcProvider)
          owners.set(worldName, ownerOf.toLowerCase())
          walletsStats.set(ownerOf.toLowerCase(), { owner: ownerOf.toLowerCase(), ownedLands: 0, activeRentals: 0 })
          console.log(`Adding owner of world ${worldName}: ${ownerOf.toLowerCase()}`)
        } catch (error: any) {
          console.log(`Error fetching owner of world ${worldName}: ${error.message}`)
        }
      }

      // Fetch balanceOf from LAND contract for each owner
      for (const [_, walletStats] of walletsStats) {
        // TODO: Fetch balanceOf from LAND contract
        const numberOfLandOwned = 0
        walletStats.ownedLands = numberOfLandOwned
      }

      // Fetch the active rental contracts for each owner
      for (const [_, walletStats] of walletsStats) {
        // TODO: Fetch active rental contracts for each owner
        const activeRentals = 0
        walletStats.activeRentals = activeRentals
      }

      return {
        shouldBeIndexed(worldName: string): boolean {
          if (owners.has(worldName)) {
            const wallet = owners.get(worldName)
            if (wallet) {
              const worldStats = walletsStats.get(wallet)!
              return !!worldStats && (worldStats.ownedLands > 0 || worldStats.activeRentals > 0)
            }
          }

          return false
        }
      }
    }
  }
}
