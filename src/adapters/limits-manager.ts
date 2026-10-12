import { AppComponents, ILimitsManager, MB_BigInt, Whitelist } from '../types'
import { isNameOwnershipValidationIgnored } from '../logic/name-ownership-validation'

const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m))
const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m))

export async function createLimitsManagerComponent({
  config,
  nameOwnership,
  uploadLimits,
  walletStats,
  whitelist,
  worldsManager
}: Pick<
  AppComponents,
  'config' | 'nameOwnership' | 'uploadLimits' | 'walletStats' | 'whitelist' | 'worldsManager'
>): Promise<ILimitsManager> {
  const hardMaxParcels = await config.requireNumber('MAX_PARCELS')
  const hardMaxSize = await config.requireNumber('MAX_SIZE')
  const hardMaxSizeForEns = await config.requireNumber('ENS_MAX_SIZE')
  const hardAllowSdk6 = (await config.requireString('ALLOW_SDK6')) === 'true'
  const { maxSceneSizeInBytes } = uploadLimits

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
    // World names arrive with arbitrary casing (entity.metadata.worldConfiguration.name); every
    // check (whitelist keys, TLD, ownership) runs on the lowercased name.
    async getAllowSdk6For(rawWorldName: string): Promise<boolean> {
      const worldName = rawWorldName.toLowerCase()
      const currentWhitelist = await resolveWhitelist()
      return currentWhitelist[worldName]?.allow_sdk6 || hardAllowSdk6
    },
    async getMaxAllowedParcelsFor(rawWorldName: string): Promise<number> {
      const worldName = rawWorldName.toLowerCase()
      const currentWhitelist = await resolveWhitelist()
      return currentWhitelist[worldName]?.max_parcels || hardMaxParcels
    },
    async getMaxAllowedSizeInBytesFor(rawWorldName: string, parcels?: string[]): Promise<bigint> {
      const worldName = rawWorldName.toLowerCase()
      if (await isNameOwnershipValidationIgnored(config)) {
        // The fixture has no wallet/subgraph state. Keep the configured hard
        // limit while the explicit bypass is enabled instead of trying to
        // resolve ownership through an external service.
        return BigInt(hardMaxSize) * MB_BigInt
      }
      if (worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')) {
        return BigInt(hardMaxSizeForEns) * MB_BigInt
      }

      const currentWhitelist = await resolveWhitelist()
      const whitelistEntry = currentWhitelist[worldName]
      if (whitelistEntry) {
        return BigInt(whitelistEntry.max_size_in_mb || hardMaxSize) * MB_BigInt
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
        : stats.dclNames.find((name) => name.name === worldName)?.size || 0n

      const usedSpace = stats.usedSpace - creditedBackSize

      // The owner's remaining allowance (0 if exceeded), capped per scene
      return bigIntMin(bigIntMax(stats.maxAllowedSpace - usedSpace, 0n), maxSceneSizeInBytes)
    }
  }
}
