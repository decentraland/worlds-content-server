import { AppComponents, BlockedRecord, IRunnable, Notification, TWO_DAYS_IN_MS, Whitelist, WorldRecord } from '../types'
import SQL from 'sql-template-strings'
import { CronJob } from 'cron'

type WorldData = Pick<WorldRecord, 'name' | 'owner' | 'size' | 'entity'>

export async function createUpdateOwnerJob(
  components: Pick<
    AppComponents,
    'config' | 'database' | 'fetch' | 'logs' | 'nameOwnership' | 'notificationService' | 'walletStats'
  >
): Promise<IRunnable<void>> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('update-owner-job')

  const whitelistUrl = await config.requireString('WHITELIST_URL')
  const builderUrl = await config.requireString('BUILDER_URL')

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
        RETURNING wallet, created_at, updated_at
    `
    const result = await components.database.query<BlockedRecord>(sql)
    if (result.rowCount > 0) {
      const { warning, blocked } = result.rows.reduce(
        (r, o) => {
          if (o.updated_at.getTime() - o.created_at.getTime() < TWO_DAYS_IN_MS) {
            r.warning.push(o)
          } else {
            r.blocked.push(o)
          }
          return r
        },
        { warning: [] as BlockedRecord[], blocked: [] as BlockedRecord[] }
      )

      const notifications: Notification[] = []

      logger.info(
        `Sending notifications for wallets that are about to be blocked: ${warning.map((r) => r.wallet).join(', ')}`
      )
      notifications.push(
        ...warning.map(
          (record): Notification => ({
            type: 'worlds_missing_resources',
            eventKey: `detected-${record.created_at.toISOString().slice(0, 10)}`,
            address: record.wallet,
            metadata: {
              title: 'Missing Resources',
              description: 'World access at risk in 48hs. Rectify now to prevent disruption.',
              url: `${builderUrl}/worlds?tab=dcl`,
              when: record.created_at.getTime() + TWO_DAYS_IN_MS
            },
            timestamp: record.created_at.getTime()
          })
        )
      )

      logger.info(
        `Sending notifications for wallets that have already been blocked: ${blocked.map((r) => r.wallet).join(', ')}`
      )
      notifications.push(
        ...blocked.map(
          (record): Notification => ({
            type: 'worlds_access_restricted',
            eventKey: `detected-${record.created_at.toISOString().slice(0, 10)}`,
            address: record.wallet,
            metadata: {
              title: 'Worlds restricted',
              description: 'Access to your Worlds has been restricted due to insufficient resources.',
              url: `${builderUrl}/worlds?tab=dcl`,
              when: record.created_at.getTime() + TWO_DAYS_IN_MS
            },
            timestamp: record.created_at.getTime() + TWO_DAYS_IN_MS
          })
        )
      )
      await components.notificationService.sendNotifications(notifications)
    }
  }

  async function clearOldBlockingRecords(startDate: Date) {
    const sql = SQL`
        DELETE
        FROM blocked
        WHERE updated_at < ${startDate}
        RETURNING wallet, created_at
    `
    const result = await components.database.query(sql)
    if (result.rowCount > 0) {
      logger.info(`Sending block removal notifications for wallets: ${result.rows.map((row) => row.wallet).join(', ')}`)
      await components.notificationService.sendNotifications(
        result.rows.map((record) => ({
          type: 'worlds_access_restored',
          eventKey: `detected-${record.created_at.toISOString().slice(0, 10)}`,
          address: record.wallet,
          metadata: {
            title: 'Worlds available',
            description: 'Access to your Worlds has been restored.',
            url: `${builderUrl}/worlds?tab=dcl`
          },
          timestamp: Date.now()
        }))
      )
    }
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
        const sql = SQL`
            UPDATE worlds
            SET owner = ${newOwner?.toLowerCase()}
            WHERE name = ${worldData.name.toLowerCase()}`
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

    const whiteList = await fetch.fetch(whitelistUrl).then(async (data) => (await data.json()) as unknown as Whitelist)

    for (const [owner, worlds] of worldsByOwner) {
      if (worlds.length === 0) {
        continue
      }

      const walletStats = await components.walletStats.get(owner)

      // The size of whitelisted worlds does not count towards the wallet's used space
      let sizeOfWhitelistedWorlds = 0n
      for (const world of worlds) {
        if (world in whiteList) {
          sizeOfWhitelistedWorlds += BigInt(walletStats.dclNames.find((w) => w.name === world)?.size || 0)
        }
      }

      if (walletStats.maxAllowedSpace < walletStats.usedSpace - sizeOfWhitelistedWorlds) {
        logger.info(
          `Creating or updating blocking record for ${owner} as maxAllowed is ${
            walletStats.maxAllowedSpace
          } and used is ${walletStats.usedSpace - sizeOfWhitelistedWorlds}. Affected worlds: ${walletStats.dclNames
            .concat(walletStats.ensNames)
            .map((w) => w.name)
            .join(', ')}.`
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
