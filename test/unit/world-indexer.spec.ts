import { createWorldsIndexerComponent } from '../../src/adapters/worlds-indexer'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'
import { Variables } from '@well-known-components/thegraph-component/dist/types'
import { createMockCommsAdapterComponent } from '../mocks/comms-adapter-mock'
import { ICommsAdapter, IEngagementStatsFetcher, WorldData, WorldStats } from '../../src/types'
import { createMockEngagementStatsFetcherComponent } from '../mocks/engagement-stats-fetcher-mock'
import { EthAddress } from '@dcl/schemas'

describe('All data from worlds', function () {
  let commsAdapter: ICommsAdapter
  let config: IConfigComponent
  let logs
  let storage
  let worldsManager
  let worldsIndexer
  let engagementStatsFetcher: IEngagementStatsFetcher
  let owners: Map<string, EthAddress>
  let walletsStats: Map<EthAddress, WorldStats>
  const marketplaceSubGraph = {
    query: async (_query: string, _variables?: Variables, _remainingAttempts?: number): Promise<any> => ({
      names: []
    })
  }

  beforeEach(async () => {
    commsAdapter = createMockCommsAdapterComponent()
    config = await createConfigComponent({})
    logs = await createLogComponent({ config })
    storage = await createInMemoryStorage()
    worldsManager = await createWorldsManagerComponent({ logs, storage })
    owners = new Map<string, EthAddress>()
    walletsStats = new Map<EthAddress, WorldStats>()
    engagementStatsFetcher = await createMockEngagementStatsFetcherComponent(owners, walletsStats)
    worldsIndexer = await createWorldsIndexerComponent({
      commsAdapter,
      logs,
      engagementStatsFetcher,
      storage,
      worldsManager
    })
  })

  it('creates an index of all the data from all the worlds deployed in the server', async () => {
    await worldsIndexer.createIndex()

    expect(storage.exist('global-index.json')).toBeTruthy()

    const content = await storage.retrieve('global-index.json')
    const stored = JSON.parse((await streamToBuffer(await content.asStream())).toString())
    console.log(stored)
    expect(stored).toMatchObject([])
  })

  it('retrieves last created index but it has not been created', async () => {
    await expect(() => worldsIndexer.getIndex()).rejects.toEqual('No global index found')
  })

  it('retrieves last created index', async () => {
    const worldData: WorldData = {
      name: 'world-name.dcl.eth',
      owner: '0x123',
      indexInPlaces: true,
      scenes: [
        {
          id: 'bafkreielwj3ki46munydwn4ayazdvmjln76khmz2xyaf5v6dkmo6yoebbi',
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          thumbnail: 'https://localhost:3000/contents/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
          pointers: ['20,24'],
          timestamp: 1683916946483
        }
      ]
    }
    await storage.storeStream(
      'global-index.json',
      bufferToStream(Buffer.from(stringToUtf8Bytes(JSON.stringify([worldData]))))
    )
    const index = await worldsIndexer.getIndex()

    expect(index).toEqual([
      {
        ...worldData,
        currentUsers: 2
      }
    ])
  })
})
