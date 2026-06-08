import { AppComponents, ILimitsManager, MB_BigInt, Whitelist } from '../types'
import { LRUCache } from 'lru-cache'

const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m))

export async function createLimitsManagerComponent({
  config,
  fetch,
  logs,
  nameOwnership,
  walletStats,
  worldsManager
}: Pick<
  AppComponents,
  'config' | 'fetch' | 'logs' | 'nameOwnership' | 'walletStats' | 'worldsManager'
>): Promise<ILimitsManager> {
  const logger = logs.getLogger('limits-manager')
  const hardMaxParcels = await config.requireNumber('MAX_PARCELS')
  const hardMaxSize = await config.requireNumber('MAX_SIZE')
  const hardMaxSizeForEns = await config.requireNumber('ENS_MAX_SIZE')
  const hardAllowSdk6 = (await config.requireString('ALLOW_SDK6')) === 'true'
  const whitelistUrl = await config.requireString('WHITELIST_URL')

  const CONFIG_KEY = 'config'
  const cache = new LRUCache<any, Whitelist>({
    max: 1,
    ttl: 10 * 60 * 1000, // cache for 10 minutes
    fetchMethod: async (_, staleValue): Promise<Whitelist> => {
      return await fetch
        .fetch(whitelistUrl)
        .then(async (data) => (await data.json()) as unknown as Whitelist)
        .catch((_: any) => {
          logger.warn(
            `Error fetching the whitelist: ${_.message}. Returning last known whitelist: ${JSON.stringify(
              staleValue || {}
            )}`
          )
          return staleValue || {}
        })
    }
  })

  return {
    async getAllowSdk6For(worldName: string): Promise<boolean> {
      const whitelist = (await cache.fetch(CONFIG_KEY))!
      return whitelist[worldName]?.allow_sdk6 || hardAllowSdk6
    },
    async getMaxAllowedParcelsFor(worldName: string): Promise<number> {
      const whitelist = (await cache.fetch(CONFIG_KEY))!
      return whitelist[worldName]?.max_parcels || hardMaxParcels
    },
    async getMaxAllowedSizeInBytesFor(worldName: string, parcels?: string[]): Promise<bigint> {
      if (worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')) {
        return BigInt(hardMaxSizeForEns) * MB_BigInt
      }

      const whitelist = (await cache.fetch(CONFIG_KEY))!
      if (whitelist[worldName]) {
        return BigInt(whitelist[worldName]!.max_size_in_mb || hardMaxSize) * MB_BigInt
      }

      const owners = await nameOwnership.findOwners([worldName])
      const owner = owners.get(worldName)
      if (!owner) {
        throw new Error(`Could not determine owner for world ${worldName}`)
      }

      const stats = await walletStats.get(owner)

      // A deployment only replaces the scenes overlapping its parcels, so credit back only
      // those (not the whole world, which would over-count in multi-scene worlds). Falls
      // back to the whole-world size when parcels aren't provided.
      const creditedBackSize = parcels
        ? await worldsManager.getDeployedSceneSizeForParcels(worldName, parcels)
        : stats.dclNames.find((name) => name.name === worldName.toLowerCase())?.size || 0n

      const usedSpace = stats.usedSpace - creditedBackSize

      // We get the remaining space for the account (if any) or 0 if the space is already exceeded
      return bigIntMax(stats.maxAllowedSpace - usedSpace, 0n)
    }
  }
}
