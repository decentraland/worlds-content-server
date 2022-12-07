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
  const hardAllowSdk6 = (await config.requireString('ALLOW_SDK6')) === 'true'
  const whitelistUrl = await config.requireString('WHITELIST_URL')

  const cache = new LRU<any, Whitelist>({
    max: 1,
    ttl: 10 * 60 * 1000, // cache for 5 minutes
    fetchMethod: async (_): Promise<Whitelist> =>
      await fetch.fetch(whitelistUrl).then((data) => data.json() as unknown as Whitelist)
  })

  return {
    async getAllowSdk6For(worldName: string): Promise<boolean> {
      const whitelist = (await cache.fetch('config'))!
      return whitelist[worldName]?.allow_sdk6 || hardAllowSdk6
    },
    async getMaxAllowedParcelsFor(worldName: string): Promise<number> {
      const whitelist = (await cache.fetch('config'))!
      return whitelist[worldName]?.max_parcels || hardMaxParcels
    },
    async getMaxAllowedSizeInMbFor(worldName: string): Promise<number> {
      const whitelist = (await cache.fetch('config'))!
      return whitelist[worldName]?.max_size_in_mb || hardMaxSize
    }
  }
}
