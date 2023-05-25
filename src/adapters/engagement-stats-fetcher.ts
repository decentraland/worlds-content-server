import { AppComponents, IEngagementStats, IEngagementStatsFetcher, WorldStats } from '../types'
import { EthAddress } from '@dcl/schemas'

const RENTAL_QUERY = `
      query activeRentals($wallets: [String!]!, $endsAt: Int!) {
        rentals(where: {tenant_in: $wallets, isActive: true, endsAt_gt: $endsAt}) {
          tenant
          isActive
          endsAt
        }
      }`

export type RentalsResponse = {
  rentals: {
    tenant: EthAddress
    isActive: boolean
    endsAt: string
  }[]
}

export async function createEngagementStats(
  owners: Map<string, EthAddress>,
  walletsStats: Map<EthAddress, WorldStats>
) {
  return {
    statsFor(worldName: string): WorldStats | undefined {
      const wallet = owners.get(worldName)
      if (wallet) {
        return walletsStats.get(wallet)
      }
      return undefined
    },
    ownerOf(worldName: string): EthAddress | undefined {
      return owners.get(worldName)
    },
    shouldBeIndexed(worldName: string): boolean {
      const wallet = owners.get(worldName)
      if (wallet) {
        const worldStats = walletsStats.get(wallet)
        return !!worldStats && (worldStats.ownedLands > 0 || worldStats.activeRentals > 0)
      }

      return false
    }
  }
}

export async function createEngagementStatsFetcherComponent({
  dclRegistrarContract,
  landContract,
  logs,
  rentalsSubGraph
}: Pick<
  AppComponents,
  'dclRegistrarContract' | 'landContract' | 'logs' | 'rentalsSubGraph'
>): Promise<IEngagementStatsFetcher> {
  const logger = logs.getLogger('engagement-stats-fetcher')

  return {
    async for(worldNames: string[]): Promise<IEngagementStats> {
      // First figure out the owners for each of the worlds
      const owners = new Map<string, EthAddress>()
      const walletsStats = new Map<EthAddress, WorldStats>()
      await Promise.all(
        worldNames.map(async (worldName: string) => {
          try {
            const ownerOf = await dclRegistrarContract.getOwnerOf(worldName.replace('.dcl.eth', ''))
            owners.set(worldName, ownerOf)
            walletsStats.set(ownerOf, { owner: ownerOf, ownedLands: 0, activeRentals: 0 })
            logger.info(`Adding owner of world ${worldName}: ${ownerOf}`)
          } catch (error: any) {
            logger.warn(`Error fetching owner of world ${worldName}: ${error.message}`)
          }
        })
      )

      // Fetch balanceOf from LAND contract for each owner
      await Promise.all(
        Array.from(walletsStats.values()).map(async (walletStats: WorldStats) => {
          try {
            walletStats.ownedLands = await landContract.balanceOf(walletStats.owner)
            logger.info(`Adding balanceOf for ${walletStats.owner}: ${walletStats.ownedLands}`)
          } catch (e: any) {
            logger.warn(`Error fetching balanceOf for ${walletStats.owner}: ${e.message}`)
          }
        })
      )

      // Find out which wallets have active rental contracts
      const result = await rentalsSubGraph.query<RentalsResponse>(RENTAL_QUERY, {
        wallets: Array.from(walletsStats.keys()).map((wallet) => wallet.toLowerCase()),
        endsAt: Math.floor(Date.now() / 1000)
      })
      result.rentals.forEach((rental) => {
        const walletStats = walletsStats.get(rental.tenant.toLowerCase())
        if (walletStats) {
          walletStats.activeRentals++
        }
      })

      return createEngagementStats(owners, walletsStats)
    }
  }
}
