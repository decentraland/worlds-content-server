import { AppComponents, IRunnable } from '../types'
import SQL from 'sql-template-strings'
import { CronJob } from 'cron'
import { errorMessage } from '../logic/utils'

type WorldData = {
  name: string
  owner: string
  size: bigint
  hasDeployedScenes: boolean
}

export async function createUpdateOwnerJob(
  components: Pick<AppComponents, 'blocking' | 'database' | 'logs' | 'nameOwnership' | 'permissionsManager'>
): Promise<IRunnable<void>> {
  const { blocking, database, logs, nameOwnership, permissionsManager } = components
  const logger = logs.getLogger('update-owner-job')

  async function run() {
    const startDate = new Date()

    // Get the worlds that need their owner reconciled, aggregating total size from world_scenes.
    // Worlds with no deployed scene are included when they carry permissions: the permission APIs
    // create the world entry on their own, so a name transferred while empty would otherwise never
    // have its owner refreshed and would keep the previous owner's permissions indefinitely.
    const records = await database.query<{
      name: string
      owner: string
      size: string
      has_deployed_scenes: boolean
    }>(`
      SELECT
        w.name,
        w.owner,
        COALESCE(SUM(ws.size), 0)::text as size,
        COUNT(ws.world_name) > 0 as has_deployed_scenes
      FROM worlds w
      LEFT JOIN world_scenes ws ON w.name = ws.world_name AND ws.status = 'DEPLOYED'
      WHERE EXISTS (
              SELECT 1 FROM world_scenes s WHERE s.world_name = w.name AND s.status = 'DEPLOYED'
            )
         OR EXISTS (
              SELECT 1 FROM world_permissions p WHERE p.world_name = w.name
            )
      GROUP BY w.name, w.owner
    `)
    const onlyDclNameRecords = records.rows
      .filter((row) => !!row.name && row.name.endsWith('.dcl.eth'))
      .map((row) => {
        return {
          name: row.name,
          owner: row.owner,
          size: BigInt(row.size),
          hasDeployedScenes: row.has_deployed_scenes
        }
      })
    const recordsByName = onlyDclNameRecords.reduce((acc, curr) => {
      acc.set(curr.name, curr)
      return acc
    }, new Map<string, WorldData>())

    const worldWithOwners = await nameOwnership.findOwners([...recordsByName.keys()])

    // Step 1
    // Compare the owners of stored vs retrieved from name ownership. Update owners in DB (and in
    // memory), and drop the permissions the previous owner had granted. Errors are isolated per
    // world so one failure cannot prevent the others from being processed.
    for (const worldData of onlyDclNameRecords) {
      const newOwner = worldWithOwners.get(worldData.name)
      // DCL names never expire, so a missing owner means the lookup failed rather than the name
      // being unowned. Treating it as a change would blank the owner column and, worse, revoke
      // every permission of the world over what is only a transient failure.
      if (!newOwner) {
        logger.warn(`Skipping ${worldData.name}: its current owner could not be resolved`)
        continue
      }

      const lowerCaseNewOwner = newOwner.toLowerCase()
      // A world can predate the owner column, so its stored owner may be missing. That counts as a
      // change: it gets recorded, and the permissions of whoever held the name before are dropped.
      if (worldData.owner?.toLowerCase() === lowerCaseNewOwner) {
        continue
      }

      logger.info(`Updating owner of ${worldData.name} from ${worldData.owner} to ${newOwner}`)

      try {
        // Both statements have to commit together. Persisting the new owner on its own would make
        // the next run see no change at all, so a failed cleanup would leave the previous owner's
        // permissions in place forever instead of being retried.
        await database.withAsyncContextTransaction(async () => {
          await database.query(SQL`
            UPDATE worlds
            SET owner = ${lowerCaseNewOwner}
            WHERE name = ${worldData.name.toLowerCase()}`)

          const revoked = await permissionsManager.deletePermissionsNotGrantedUnderOwner(
            worldData.name,
            lowerCaseNewOwner
          )

          if (revoked.length > 0) {
            logger.info(
              `Revoked ${revoked.length} permission(s) of ${worldData.name} that predate its ownership change: ` +
                revoked.map((r) => `${r.permissionType}:${r.address}`).join(', ')
            )
          }
        })

        worldData.owner = newOwner
      } catch (error) {
        logger.error(`Failed to apply the ownership change of ${worldData.name}`, { error: errorMessage(error) })
      }
    }

    // Step 2
    // For each owner, (re)create a blocking record when over quota. Errors are isolated per
    // owner so one failure cannot prevent the others from being processed. Finally, clear up
    // all blocking records that were not refreshed in this run — except those of owners whose
    // status could not be evaluated, which must remain blocked until the next run.
    // Only worlds holding deployed scenes count towards a wallet's quota, so the reconciliation
    // above being wider than that must not pull extra wallets into the blocking evaluation.
    const owners = new Set<string>()
    for (const worldData of onlyDclNameRecords) {
      if (!worldData.hasDeployedScenes) {
        continue
      }
      const owner = worldWithOwners.get(worldData.name)
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

    await blocking.collectStaleBlockingRecords(startDate, failedOwners)
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
