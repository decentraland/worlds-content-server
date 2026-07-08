import {
  EthAddress,
  Events,
  WorldsAccessRestoredEvent,
  WorldsAccessRestrictedEvent,
  WorldsMissingResourcesEvent
} from '@dcl/schemas'
import SQL from 'sql-template-strings'
import { AppComponents, BlockedRecord, TWO_DAYS_IN_MS, WalletStats, Whitelist } from '../../types'
import { errorMessage } from '../../logic/utils'
import { IBlockingComponent } from './types'

export async function createBlockingComponent(
  components: Pick<AppComponents, 'config' | 'database' | 'logs' | 'snsClient' | 'walletStats' | 'whitelist'>
): Promise<IBlockingComponent> {
  const { config, database, logs, snsClient, walletStats, whitelist } = components
  const logger = logs.getLogger('blocking')

  const builderUrl = await config.requireString('BUILDER_URL')

  // Space counted against the wallet's quota. Whitelisted worlds do not consume allowance,
  // so their sizes are discounted. Both the block and unblock decisions use this single
  // definition so they can never disagree on whether a wallet is over quota.
  function effectiveUsedSpace(stats: WalletStats, whitelistData: Whitelist): bigint {
    const whitelistedSize = stats.dclNames
      .filter((world) => world.name in whitelistData)
      .reduce((acc, world) => acc + world.size, 0n)
    return stats.usedSpace - whitelistedSize
  }

  function isOverQuota(stats: WalletStats, whitelistData: Whitelist): boolean {
    return stats.maxAllowedSpace < effectiveUsedSpace(stats, whitelistData)
  }

  async function getBlockedSince(wallet: EthAddress): Promise<Date | undefined> {
    const result = await database.query<{ created_at: Date }>(
      SQL`SELECT created_at FROM blocked WHERE wallet = ${wallet.toLowerCase()}`
    )
    return result.rowCount > 0 ? result.rows[0].created_at : undefined
  }

  function buildRestoredEvent(wallet: string, createdAt: Date): WorldsAccessRestoredEvent {
    return {
      type: Events.Type.WORLD,
      subType: Events.SubType.Worlds.WORLDS_ACCESS_RESTORED,
      key: `detected-${createdAt.toISOString().slice(0, 10)}`,
      timestamp: Date.now(),
      metadata: {
        title: 'Worlds available',
        description: 'Access to your Worlds has been restored.',
        url: `${builderUrl}/worlds?tab=dcl`,
        attendee: wallet
      }
    }
  }

  async function upsertBlockingRecord(wallet: EthAddress): Promise<void> {
    const now = new Date()
    const result = await database.query<BlockedRecord>(SQL`
        INSERT INTO blocked (wallet, created_at, updated_at)
        VALUES (${wallet.toLowerCase()}, ${now}, ${now})
        ON CONFLICT (wallet)
            DO UPDATE SET updated_at = ${now}
        RETURNING wallet, created_at, updated_at
    `)

    if (result.rowCount === 0) {
      return
    }

    // Freshly-created records (created_at close to updated_at) are still within the grace
    // period and get a "missing resources" warning; older records are already enforced.
    const { warning, blocked } = result.rows.reduce(
      (acc, record) => {
        if (record.updated_at.getTime() - record.created_at.getTime() < TWO_DAYS_IN_MS) {
          acc.warning.push(record)
        } else {
          acc.blocked.push(record)
        }
        return acc
      },
      { warning: [] as BlockedRecord[], blocked: [] as BlockedRecord[] }
    )

    const events: (WorldsMissingResourcesEvent | WorldsAccessRestrictedEvent)[] = [
      ...warning.map(
        (record): WorldsMissingResourcesEvent => ({
          type: Events.Type.WORLD,
          subType: Events.SubType.Worlds.WORLDS_MISSING_RESOURCES,
          key: `detected-${record.created_at.toISOString().slice(0, 10)}`,
          timestamp: record.created_at.getTime(),
          metadata: {
            title: 'Missing Resources',
            description: 'World access at risk in 48hs. Rectify now to prevent disruption.',
            url: `${builderUrl}/worlds?tab=dcl`,
            when: record.created_at.getTime() + TWO_DAYS_IN_MS,
            address: record.wallet
          }
        })
      ),
      ...blocked.map(
        (record): WorldsAccessRestrictedEvent => ({
          type: Events.Type.WORLD,
          subType: Events.SubType.Worlds.WORLDS_ACCESS_RESTRICTED,
          key: `detected-${record.created_at.toISOString().slice(0, 10)}`,
          timestamp: record.created_at.getTime() + TWO_DAYS_IN_MS,
          metadata: {
            title: 'Worlds restricted',
            description: 'Access to your Worlds has been restricted due to insufficient resources.',
            when: record.created_at.getTime() + TWO_DAYS_IN_MS,
            address: record.wallet
          }
        })
      )
    ]

    if (events.length > 0) {
      logger.info(
        `Publishing ${warning.length} missing-resources and ${blocked.length} access-restricted event(s) for ${wallet}.`
      )
      await snsClient.publishMessages(events)
    }
  }

  async function blockIfOverQuota(wallet: EthAddress): Promise<boolean> {
    const [stats, currentWhitelist] = await Promise.all([walletStats.get(wallet), whitelist.get()])

    if (!isOverQuota(stats, currentWhitelist)) {
      return false
    }

    logger.info(
      `Creating or updating blocking record for ${wallet} as maxAllowed is ${
        stats.maxAllowedSpace
      } and used is ${effectiveUsedSpace(stats, currentWhitelist)}. Affected worlds: ${stats.dclNames
        .concat(stats.ensNames)
        .map((world) => world.name)
        .join(', ')}.`
    )
    await upsertBlockingRecord(wallet)
    return true
  }

  async function unblockIfUnderQuota(wallet: EthAddress): Promise<boolean> {
    try {
      // Cheap short-circuit: only actually-blocked wallets are worth the expensive stats fetch.
      const createdAt = await getBlockedSince(wallet)
      if (!createdAt) {
        return false
      }

      const [stats, currentWhitelist] = await Promise.all([walletStats.get(wallet), whitelist.get()])
      if (isOverQuota(stats, currentWhitelist)) {
        return false
      }

      // The DELETE is the authoritative unblock; the notification is best-effort. Publishing it
      // separately means an SNS failure after a committed DELETE is logged (not silently lost as
      // a generic recheck failure) and does not make us report the wallet as still blocked.
      await database.query(SQL`DELETE FROM blocked WHERE wallet = ${wallet.toLowerCase()}`)
      logger.info(`Unblocked ${wallet} after it dropped back under its allowed quota.`)

      try {
        await snsClient.publishMessages([buildRestoredEvent(wallet.toLowerCase(), createdAt)])
      } catch (error) {
        logger.error(`Unblocked ${wallet} but failed to publish the access-restored event`, {
          error: errorMessage(error)
        })
      }

      return true
    } catch (error) {
      logger.error(`Failed to recheck blocked status for ${wallet}`, { error: errorMessage(error) })
      return false
    }
  }

  async function collectStaleBlockingRecords(runStartedAt: Date, keepWallets: Set<string>): Promise<void> {
    const query = SQL`
        DELETE
        FROM blocked
        WHERE updated_at < ${runStartedAt}`

    // `blocked.wallet` is always stored lowercased, so the kept wallets must be too, otherwise a
    // mixed-case address would fail the `!= ALL(...)` comparison and its record would be deleted
    // despite the caller asking to keep it. Falsy entries are dropped so the comparison can't turn
    // into NULL (which would silently delete nothing).
    const walletsToKeep = Array.from(keepWallets)
      .filter(Boolean)
      .map((wallet) => wallet.toLowerCase())
    if (walletsToKeep.length > 0) {
      query.append(SQL`
          AND wallet != ALL(${walletsToKeep})`)
    }
    query.append(SQL`
        RETURNING wallet, created_at`)

    const result = await database.query<Pick<BlockedRecord, 'wallet' | 'created_at'>>(query)

    if (result.rowCount === 0) {
      return
    }

    logger.info(`Sending block removal SNS events for wallets: ${result.rows.map((row) => row.wallet).join(', ')}`)
    await snsClient.publishMessages(result.rows.map((row) => buildRestoredEvent(row.wallet, row.created_at)))
  }

  return {
    blockIfOverQuota,
    unblockIfUnderQuota,
    collectStaleBlockingRecords
  }
}
