import { AppComponents, IWalletStats, MB_BigInt, WalletStats, WorldRecord, IWorldsManager } from '../types'
import { EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { withRetry } from '../logic/utils'

export async function createWalletStatsComponent(
  components: Pick<AppComponents, 'config' | 'database' | 'logs' | 'fetch' | 'worldsManager'>
): Promise<IWalletStats> {
  const logger = components.logs.getLogger('wallet-stats')
  const url = await components.config.getString('DCL_NAME_STATS_URL')
  if (url) {
    logger.info(`Using DCL wallet stats from ${url}.`)
  } else {
    logger.info('No DCL wallet stats url provided.')
  }

  async function fetchAccountHoldings(wallet: string) {
    if (!url) {
      return {
        owner: wallet,
        ownedLands: 0,
        ownedNames: 0,
        ownedMana: 0,
        spaceAllowance: Number.MAX_SAFE_INTEGER
      }
    }

    return await withRetry(
      async () => {
        const result = await components.fetch.fetch(`${url}/account-holdings/${wallet}`, { method: 'POST' })
        const json = await result.json()
        return json['data']
      },
      {
        maxRetries: 3,
        baseDelay: 300,
        logger
      }
    )
  }

  async function fetchStoredData(wallet: string) {
    const rows = await components.database.query<Pick<WorldRecord, 'name'>>(SQL`
        SELECT name FROM worlds WHERE owner = ${wallet.toLowerCase()}`)
    
    // Calculate total size from all scenes for each world
    const worldsData = await Promise.all(
      rows.rows.map(async (row) => {
        const totalSize = await components.worldsManager.getTotalWorldSize(row.name)
        return {
          name: row.name,
          entityId: null, // Deprecated, kept for compatibility
          size: totalSize
        }
      })
    )
    
    return worldsData
  }

  async function fetchBlockedStatus(wallet: string): Promise<Date | undefined> {
    const rows = await components.database.query<{ created_at: Date }>(SQL`
        SELECT created_at FROM blocked WHERE wallet = ${wallet.toLowerCase()}`)
    if (rows.rowCount === 1) {
      return rows.rows[0].created_at
    }
    return undefined
  }

  async function get(wallet: EthAddress): Promise<WalletStats> {
    const [holdings, storedData, blockedSince] = await Promise.all([
      fetchAccountHoldings(wallet),
      fetchStoredData(wallet),
      fetchBlockedStatus(wallet)
    ])

    const { dclNames, ensNames } = storedData
      .map((world) => ({
        name: world.name,
        size: world.size
      }))
      .reduce(
        (acc, world) => {
          acc[world.name.endsWith('.dcl.eth') ? 'dclNames' : 'ensNames'].push(world)
          return acc
        },
        { dclNames: [] as { name: string; size: bigint }[], ensNames: [] as { name: string; size: bigint }[] }
      )
    const usedSpace = dclNames.reduce((acc: bigint, curr) => acc + curr.size, 0n)

    return {
      wallet,
      dclNames,
      ensNames,
      usedSpace,
      maxAllowedSpace: BigInt(holdings.spaceAllowance) * MB_BigInt,
      blockedSince
    }
  }

  return {
    get
  }
}
