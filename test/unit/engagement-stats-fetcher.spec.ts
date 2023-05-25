import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IEngagementStats, IEngagementStatsFetcher, WorldStats } from '../../src/types'
import { EthAddress } from '@dcl/schemas'
import {
  createEngagementStats,
  createEngagementStatsFetcherComponent
} from '../../src/adapters/engagement-stats-fetcher'
import { JsonRpcProvider } from 'ethers'
import { ISubgraphComponent } from '@well-known-components/thegraph-component'
import { Variables } from '@well-known-components/thegraph-component/dist/types'
import { balanceOf, getOwnerOf } from '../../src/contracts'

jest.mock('../../src/contracts', () => ({ balanceOf: jest.fn(() => 2), getOwnerOf: jest.fn(() => '0x123') }))

describe('Engagement Stats Fetcher', function () {
  let config: IConfigComponent
  let logs
  let rentalsSubGraph: ISubgraphComponent
  let jsonRpcProvider: JsonRpcProvider
  let engagementStatsFetcher: IEngagementStatsFetcher

  beforeEach(async () => {
    config = await createConfigComponent({
      NETWORK_ID: '1'
    })
    logs = await createLogComponent({ config })
    jsonRpcProvider = new JsonRpcProvider()

    rentalsSubGraph = {
      query: (_query: string, _variables?: Variables, _remainingAttempts?: number): Promise<any> => {
        return Promise.resolve({
          rentals: [
            {
              tenant: '0x123',
              isActive: true,
              endsAt: Date.now()
            }
          ]
        })
      }
    }
    engagementStatsFetcher = await createEngagementStatsFetcherComponent({
      config,
      logs,
      jsonRpcProvider,
      rentalsSubGraph
    })
  })

  it('creates an index of all the data from all the worlds deployed in the server', async () => {
    const engagementStats = await engagementStatsFetcher.for(['world-name.dcl.eth'])

    expect(balanceOf).toHaveBeenCalledWith('0x123', 'mainnet', jsonRpcProvider)
    expect(getOwnerOf).toHaveBeenCalledWith('world-name', 'mainnet', jsonRpcProvider)

    const worldNameStats = engagementStats.ownerOf('world-name.dcl.eth')
    expect(worldNameStats).toEqual('0x123')
    expect(engagementStats.shouldBeIndexed('world-name.dcl.eth')).toBeTruthy()
    expect(engagementStats.statsFor('world-name.dcl.eth')).toEqual({ owner: '0x123', ownedLands: 2, activeRentals: 1 })
  })
})

describe('Engagement Stats', function () {
  it('creates an index of all the data from all the worlds deployed in the server', async () => {
    const owners: Map<string, EthAddress> = new Map([
      ['world.dcl.eth', '0x123'],
      ['another-world.dcl.eth', '0x456'],
      ['yet-another-world.dcl.eth', '0x789'],
      ['not-deployed-world.dcl.eth', '0x135']
    ])
    const walletStats: Map<EthAddress, WorldStats> = new Map([
      ['0x123', { owner: '0x123', ownedLands: 1, activeRentals: 1 }],
      ['0x456', { owner: '0x456', ownedLands: 0, activeRentals: 0 }],
      ['0x789', { owner: '0x789', ownedLands: 0, activeRentals: 1 }]
    ])
    const engagementStats: IEngagementStats = await createEngagementStats(owners, walletStats)
    expect(engagementStats.ownerOf('world.dcl.eth')).toEqual('0x123')
    expect(engagementStats.ownerOf('another-world.dcl.eth')).toEqual('0x456')
    expect(engagementStats.ownerOf('yet-another-world.dcl.eth')).toEqual('0x789')

    expect(engagementStats.shouldBeIndexed('world.dcl.eth')).toBeTruthy()
    expect(engagementStats.shouldBeIndexed('another-world.dcl.eth')).toBeFalsy()
    expect(engagementStats.shouldBeIndexed('yet-another-world.dcl.eth')).toBeTruthy()

    expect(engagementStats.statsFor('world.dcl.eth')).toEqual({ owner: '0x123', ownedLands: 1, activeRentals: 1 })
    expect(engagementStats.statsFor('another-world.dcl.eth')).toEqual({
      owner: '0x456',
      ownedLands: 0,
      activeRentals: 0
    })
    expect(engagementStats.statsFor('yet-another-world.dcl.eth')).toEqual({
      owner: '0x789',
      ownedLands: 0,
      activeRentals: 1
    })
    expect(engagementStats.statsFor('non-existing-world.dcl.eth')).toBeUndefined()
    expect(engagementStats.shouldBeIndexed('non-existing-world.dcl.eth')).toBeFalsy()
  })
})
