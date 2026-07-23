import { AppComponents, IRunnable } from '../types'
import SQL from 'sql-template-strings'
import { CronJob } from 'cron'
import { errorMessage } from '../logic/utils'

type WorldData = {
  name: string
  owner: string
  size: bigint
}

export async function createUpdateOwnerJob(
  components: Pick<AppComponents, 'blocking' | 'database' | 'logs' | 'nameOwnership'>
): Promise<IRunnable<void>> {
  const { blocking, database, logs, nameOwnership } = components
  const logger = logs.getLogger('update-owner-job')

  async function run() {
    const startDate = new Date()

    // Get worlds with at least one scene deployed, aggregating total size from world_scenes
    const records = await database.query<WorldData>(`
      SELECT w.name, w.owner, COALESCE(SUM(ws.size), 0)::text as size
      FROM worlds w
      INNER JOIN world_scenes ws ON w.name = ws.world_name AND ws.status = 'DEPLOYED'
      GROUP BY w.name, w.owner
    `)
    const onlyDclNameRecords = records.rows
      .filter((row) => !!row.name && row.name.endsWith('.dcl.eth'))
      .map((row) => {
        return {
          name: row.name,
          owner: row.owner,
          size: BigInt(row.size)
        }
      })
    const recordsByName = onlyDclNameRecords.reduce((acc, curr) => {
      acc.set(curr.name, curr)
      return acc
    }, new Map<string, WorldData>())

    const worldWithOwners = await nameOwnership.findOwners([...recordsByName.keys()])

    // Step 1
    // Compare the owners of stored vs retrieved from name ownership
    // Update owners in DB (and in memory)
    //
    // Owners the resolver could not answer for (subgraph lag, partial RPC degradation — DCL names
    // always have an owner on-chain, but the resolver is not always able to report it) are tracked so
    // their stored wallets are protected from the stale-record collection below: their quota status
    // was never re-evaluated this run, so their blocking records must survive until a run that can.
    const unresolvedOwners = new Set<string>()
    for (const worldData of onlyDclNameRecords) {
      const newOwner = worldWithOwners.get(worldData.name)
      if (!newOwner) {
        // Never write the resolution gap into the DB: NULLing the owner would orphan the world from
        // quota accounting (walletStats and the blocked JOIN key on it). Keep the stored owner and
        // let a later run reconcile.
        if (worldData.owner) {
          unresolvedOwners.add(worldData.owner.toLowerCase())
        }
        logger.warn(`Owner of ${worldData.name} could not be resolved; keeping stored owner ${worldData.owner}`)
        continue
      }
      if (worldData.owner?.toLowerCase() !== newOwner.toLowerCase()) {
        logger.info(`Updating owner of ${worldData.name} from ${worldData.owner} to ${newOwner}`)
        const sql = SQL`
            UPDATE worlds
            SET owner = ${newOwner.toLowerCase()}
            WHERE name = ${worldData.name.toLowerCase()}`
        await database.query(sql)
        worldData.owner = newOwner
      }
    }

    // Step 2
    // For each owner, (re)create a blocking record when over quota. Errors are isolated per
    // owner so one failure cannot prevent the others from being processed. Finally, clear up
    // all blocking records that were not refreshed in this run — except those of owners whose
    // status could not be evaluated, which must remain blocked until the next run.
    const owners = new Set<string>()
    for (const owner of worldWithOwners.values()) {
      if (owner) {
        owners.add(owner)
      }
    }

    const failedOwners = new Set<string>()
    for (const owner of owners) {
      try {
        await blocking.blockIfOverQuota(owner)
      } catch (error) {
        failedOwners.add(owner)
        logger.error(`Failed to process blocking status for wallet ${owner}`, { error: errorMessage(error) })
      }
    }

    // Wallets whose quota was not re-evaluated this run must keep their blocking records: both those
    // whose evaluation threw and those whose worlds' names could not be resolved (they never entered
    // the owners set above, so without this a silent resolver degradation would mass-unblock them).
    await blocking.collectStaleBlockingRecords(startDate, new Set([...failedOwners, ...unresolvedOwners]))
  }

  async function start(): Promise<void> {
    logger.info('Scheduling update owner job')
    const job = new CronJob(
      '0 0 */12 * * *',
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
