import { AppComponents, IWalletStats, MB_BigInt, WalletStats, WorldRecord } from '../types'
import { EthAddress } from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { withRetry } from '../logic/utils'

const DEFAULT_STATS_TIMEOUT_MS = 3000

export async function createWalletStatsComponent(
  components: Pick<AppComponents, 'config' | 'database' | 'logs' | 'fetch'>
): Promise<IWalletStats> {
  const logger = components.logs.getLogger('wallet-stats')
  const url = await components.config.getString('DCL_NAME_STATS_URL')
  const timeoutMs = (await components.config.getNumber('DCL_NAME_STATS_TIMEOUT_MS')) ?? DEFAULT_STATS_TIMEOUT_MS
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
        // Bounds each attempt, body included, so a stalled stats service can't hang its callers.
        const abortController = new AbortController()
        const timer = setTimeout(() => abortController.abort(), timeoutMs)
        try {
          const result = await components.fetch.fetch(`${url}/account-holdings/${wallet}`, {
            method: 'POST',
            abortController
          })
          const json = await result.json()
          return json['data']
        } finally {
          clearTimeout(timer)
        }
      },
      {
        maxRetries: 3,
        baseDelay: 300,
        logger
      }
    )
  }

  // The deployed size of each world the wallet owns, in one query rather than one per world.
  async function fetchStoredData(wallet: string): Promise<{ name: string; size: bigint }[]> {
    const result = await components.database.query<Pick<WorldRecord, 'name'> & { size: string }>(SQL`
        SELECT w.name, COALESCE(SUM(ws.size), 0) AS size
        FROM worlds w
        LEFT JOIN world_scenes ws ON ws.world_name = LOWER(w.name) AND ws.status = 'DEPLOYED'
        WHERE w.owner = ${wallet.toLowerCase()}
        GROUP BY w.name
        ORDER BY w.name`)

    return result.rows.map((row) => ({ name: row.name, size: BigInt(row.size) }))
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
