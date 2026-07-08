import { AppComponents, ILimitsManager, MB_BigInt, Whitelist } from '../types'

const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m))

export async function createLimitsManagerComponent({
  config,
  nameOwnership,
  walletStats,
  whitelist,
  worldsManager
}: Pick<
  AppComponents,
  'config' | 'nameOwnership' | 'walletStats' | 'whitelist' | 'worldsManager'
>): Promise<ILimitsManager> {
  const hardMaxParcels = await config.requireNumber('MAX_PARCELS')
  const hardMaxSize = await config.requireNumber('MAX_SIZE')
  const hardMaxSizeForEns = await config.requireNumber('ENS_MAX_SIZE')
  const hardAllowSdk6 = (await config.requireString('ALLOW_SDK6')) === 'true'

  // Limits fall back to the hard defaults when the whitelist is unavailable, so deployments keep
  // working during a whitelist outage instead of erroring on a missing override.
  async function resolveWhitelist(): Promise<Whitelist> {
    try {
      return await whitelist.get()
    } catch {
      return {}
    }
  }

  return {
    async getAllowSdk6For(worldName: string): Promise<boolean> {
      const currentWhitelist = await resolveWhitelist()
      return currentWhitelist[worldName]?.allow_sdk6 || hardAllowSdk6
    },
    async getMaxAllowedParcelsFor(worldName: string): Promise<number> {
      const currentWhitelist = await resolveWhitelist()
      return currentWhitelist[worldName]?.max_parcels || hardMaxParcels
    },
    async getMaxAllowedSizeInBytesFor(worldName: string, parcels?: string[]): Promise<bigint> {
      if (worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')) {
        return BigInt(hardMaxSizeForEns) * MB_BigInt
      }

      const currentWhitelist = await resolveWhitelist()
      if (currentWhitelist[worldName]) {
        return BigInt(currentWhitelist[worldName]!.max_size_in_mb || hardMaxSize) * MB_BigInt
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
