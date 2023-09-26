import { AppComponents, IWalletStats, WalletStats, WorldRecord } from '../types'
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

  async function get(wallet: EthAddress): Promise<WalletStats> {
    const [holdings, storedData] = await Promise.all([fetchAccountHoldings(wallet), fetchStoredData(wallet)])

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
      maxAllowedSpace: BigInt(holdings.spaceAllowance) * 1024n * 1024n
    }
  }

  return {
    get
  }
}
