import { AppComponents, ILimitsManager } from '../types'
import LRU from 'lru-cache'

type WhitelistEntry = {
  max_parcels?: number
  max_size_in_mb?: number
  allow_sdk6?: boolean
}

type Whitelist = {
  [worldName: string]: WhitelistEntry | undefined
}

export async function createLimitsManagerComponent({
  config,
  fetch
}: Pick<AppComponents, 'config' | 'fetch'>): Promise<ILimitsManager> {
  const hardMaxParcels = await config.requireNumber('MAX_PARCELS')
  const hardMaxSize = await config.requireNumber('MAX_SIZE')
  const hardAllowSdk6 = Boolean(await config.requireString('ALLOW_SDK6'))

  const cache = new LRU<any, Whitelist>({
    max: 100,
    ttl: 5 * 60 * 1000, // cache for 5 minutes
    fetchMethod: async (_): Promise<Whitelist> => {
      console.log('fetching whitelist config')
      return await fetch
        // .fetch('https://config.decentraland.org/worlds-whitelist.json')
        .fetch('http://test.test/worlds-whitelist.json')
        .then((data) => data.json() as unknown as Whitelist)
    }
  })

  const whitelist: Whitelist = (await cache.fetch('config'))!

  return {
    getAllowSdk6For(worldName: string): boolean {
      return whitelist[worldName]?.allow_sdk6 || hardAllowSdk6
    },
    getMaxAllowedParcelsFor(worldName: string): number {
      return whitelist[worldName]?.max_parcels || hardMaxParcels
    },
    getMaxAllowedSizeInMbFor(worldName: string): number {
      return whitelist[worldName]?.max_size_in_mb || hardMaxSize
    }
  }
}
