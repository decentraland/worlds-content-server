import { AppComponents, IRunnable, WorldRecord } from '../types'
import SQL from 'sql-template-strings'
import { CronJob } from 'cron'

type WorldData = Pick<WorldRecord, 'name' | 'owner' | 'size' | 'entity'>

export function createUpdateOwnerJob(
  components: Pick<AppComponents, 'database' | 'logs' | 'nameOwnership' | 'walletStats'>
): IRunnable<void> {
  const logger = components.logs.getLogger('update-owner-job')

  function dumpMap(mapName: string, worldWithOwners: ReadonlyMap<string, any>) {
    for (const [key, value] of worldWithOwners) {
      logger.debug(`${mapName} - ${key}: ${value}`)
    }
  }

  async function upsertBlockingRecord(wallet: string) {
    const sql = SQL`
              INSERT INTO blocked (wallet, created_at, updated_at)
              VALUES (${wallet.toLowerCase()}, ${new Date()}, ${new Date()})
              ON CONFLICT (wallet) 
                  DO UPDATE SET updated_at = ${new Date()}
    `
    await components.database.query(sql)
  }

  async function clearOldBlockingRecords(startDate: Date) {
    const sql = SQL`
              DELETE FROM blocked
              WHERE updated_at < ${startDate}
    `
    await components.database.query(sql)
  }

  async function run() {
    const startDate = new Date()

    const records = await components.database.query<WorldData>(
      'SELECT name, owner, size, entity FROM worlds WHERE entity_id IS NOT NULL'
    )
    const onlyDclNameRecords = records.rows
      .filter((row) => !!row.name && row.name.endsWith('.dcl.eth'))
      .map((row) => {
        return {
          name: row.name,
          entity: row.entity,
          owner: row.owner,
          size: BigInt(row.size)
        }
      })
    const recordsByName = onlyDclNameRecords.reduce((acc, curr) => {
      acc.set(curr.name, curr)
      return acc
    }, new Map<string, WorldData>())

    const worldWithOwners = await components.nameOwnership.findOwners([...recordsByName.keys()])

    // Step 1
    // Compare the owners of stored vs retrieved from name ownership
    // Update owners in DB (and in memory)
    for (const worldData of onlyDclNameRecords) {
      // DCL names never expire, there will always be an owner. It is safe to use ! here.
      const newOwner = worldWithOwners.get(worldData.name)!
      if (worldData.owner.toLowerCase() !== newOwner?.toLowerCase()) {
        logger.info(`Updating owner of ${worldData.name} from ${worldData.owner} to ${newOwner}`)
        const sql = SQL`UPDATE worlds SET owner = ${newOwner?.toLowerCase()} WHERE name = ${worldData.name.toLowerCase()}`
        await components.database.query(sql)
        worldData.owner = newOwner
      }
    }

    // Step 2
    // For each wallet:
    // * Fetch allowance
    // * Compare with used space
    // * Create a blocking record if needed
    // * Finally, clear up all blocking records that were not updated in this run
    const worldsByOwner = new Map<string, string[]>()
    for (const [worldName, owner] of worldWithOwners) {
      if (owner) {
        const worlds = worldsByOwner.get(owner) || []
        worlds.push(worldName)
        worldsByOwner.set(owner, worlds)
      }
    }
    dumpMap('worldsByOwner', worldsByOwner)

    for (const [owner, worlds] of worldsByOwner) {
      if (worlds.length === 0) {
        continue
      }
      const walletStats = await components.walletStats.get(owner)
      const maxAllowedSpace = walletStats.maxAllowedSpace
      if (maxAllowedSpace < walletStats.usedSpace) {
        logger.info(
          `Creating or updating blocking record for ${owner} as maxAllowed is ${maxAllowedSpace} and used is ${walletStats.usedSpace}.`
        )
        await upsertBlockingRecord(owner)
      }
    }
    await clearOldBlockingRecords(startDate)
  }

  async function start(): Promise<void> {
    logger.info('Scheduling update owner job')
    const job = new CronJob(
      '0 0 */12 * * *',
      // '0 * * * * *',
      async function () {
        logger.info('Running job: ' + new Date().toISOString())
        await run()
        logger.info('Done running job: ' + new Date().toISOString())
      },
      null,
      false,
      'UCT'
    )
    job.start()
  }

  return {
    run,
    start
  }
}
