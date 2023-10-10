import { AppComponents, IWalletStats, MB_BigInt, WalletStats, WorldRecord } from '../types'
import { EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'

export async function createWalletStatsComponent(
  components: Pick<AppComponents, 'config' | 'database' | 'logs' | 'fetch'>
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
    const response = await components.fetch.fetch(`${url}/account-holdings/${wallet}`, { method: 'POST' })
    const json = await response.json()
    return json['data']
  }

  async function fetchStoredData(wallet: string) {
    const rows = await components.database.query<Pick<WorldRecord, 'name' | 'entity_id' | 'size'>>(SQL`
        SELECT name, entity_id, size FROM worlds WHERE owner = ${wallet.toLowerCase()}`)
    return rows.rows.map((row) => {
      return {
        name: row.name,
        entityId: row.entity_id,
        size: BigInt(row.size)
      }
    })
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
