import { IEngagementStats, IEngagementStatsFetcher, WorldStats } from '../../src/types'
import { EthAddress } from '@dcl/schemas'
import { createEngagementStats } from '../../src/adapters/engagement-stats-fetcher'

export function createMockEngagementStatsFetcherComponent(
  owners: Map<string, EthAddress>,
  walletsStats: Map<EthAddress, WorldStats>
): IEngagementStatsFetcher {
  return {
    for(_: string[]): Promise<IEngagementStats> {
      return createEngagementStats(owners, walletsStats)
    }
  }
}
