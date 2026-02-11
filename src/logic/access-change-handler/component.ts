import { AccessChangeAction, IAccessChangeHandler } from './types'
import type { AccessSetting } from '../access/types'
import { TRANSITION_MATRIX } from './constants'
import { AppComponents } from '../../types'
import { IAccessCheckerComponent } from '../access-checker/types'

/** Internal: reaction to an access change. kickWithoutAccess uses accessChecker. */
interface AccessChangeReaction {
  apply(worldName: string, identities: string[], accessChecker: IAccessCheckerComponent): Promise<void>
}

function createNoKickReaction({ logs }: Pick<AppComponents, 'logs'>): AccessChangeReaction {
  const logger = logs.getLogger('no-kick-reaction')

  return {
    async apply(_worldName, _identities, _accessChecker): Promise<void> {
      logger.debug(`No kicks needed for access change`, {
        worldName: _worldName,
        participantCount: _identities.length
      })
    }
  }
}

function createKickAllReaction({
  participantKicker,
  logs
}: Pick<AppComponents, 'participantKicker' | 'logs'>): AccessChangeReaction {
  const logger = logs.getLogger('kick-all-reaction')

  return {
    async apply(worldName, identities, _accessChecker): Promise<void> {
      if (identities.length === 0) return
      logger.info(`Kicking all participants due to access type change`, {
        worldName,
        participantCount: identities.length
      })
      await participantKicker.kickParticipants(worldName, identities)
    }
  }
}

/**
 * Reaction: kick only participants for whom accessChecker.checkAccess returns false (they
 * lost access). Used when AllowList → AllowList and wallets/communities changed.
 */
function createKickWithoutAccessReaction({
  participantKicker,
  logs
}: Pick<AppComponents, 'participantKicker' | 'logs'>): AccessChangeReaction {
  const logger = logs.getLogger('kick-without-access-reaction')

  return {
    async apply(worldName: string, identities: string[], accessChecker: IAccessCheckerComponent): Promise<void> {
      if (identities.length === 0) return

      const accessResults = await Promise.all(
        identities.map(async (identity) => {
          try {
            // TODO: optimize by checking wallets in one db query, and then the community gated access separately
            const hasAccess = await accessChecker.checkAccess(worldName, identity)
            return { identity, hasAccess }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            logger.warn(`Error checking access for identity, will not kick`, {
              worldName,
              identity,
              error: errorMessage
            })
            return { identity, error: errorMessage }
          }
        })
      )

      const failedIdentities = accessResults.filter(({ error }) => !!error).map(({ identity }) => identity)

      if (failedIdentities.length > 0) {
        logger.warn(`${failedIdentities.length} identities failed to check access, will not kick`, {
          worldName,
          identities: failedIdentities.join(', ')
        })
      }

      const identitiesWithoutAccess = accessResults
        .filter(({ hasAccess }) => hasAccess === false)
        .map(({ identity }) => identity)

      if (identitiesWithoutAccess.length === 0) {
        logger.debug(`All participants still have access, no kicks`, { worldName })
        return
      }

      logger.info(`Kicking participants without access after changes in the access settings`, {
        worldName,
        participantCount: identitiesWithoutAccess.length
      })

      await participantKicker.kickParticipants(worldName, identitiesWithoutAccess)
    }
  }
}

/**
 * Creates the access change handler. Selects the reaction from the transition
 * matrix (entries may be direct actions or resolvers for same-type transitions)
 * and applies it. Requires accessChecker so kickWithoutAccess can run when
 * AllowList lists change. World owners and deployers are never kicked
 * regardless of the access change.
 */
export function createAccessChangeHandler({
  peersRegistry,
  participantKicker,
  logs,
  accessChecker,
  permissionsManager
}: Pick<
  AppComponents,
  'peersRegistry' | 'participantKicker' | 'logs' | 'accessChecker' | 'permissionsManager'
>): IAccessChangeHandler {
  const logger = logs.getLogger('access-change-handler')
  const reactions: Record<AccessChangeAction, AccessChangeReaction> = {
    [AccessChangeAction.NoKick]: createNoKickReaction({ logs }),
    [AccessChangeAction.KickAll]: createKickAllReaction({ participantKicker, logs }),
    [AccessChangeAction.KickWithoutAccess]: createKickWithoutAccessReaction({ participantKicker, logs })
  }

  /**
   * Filters out identities that should never be kicked: the world owner
   * and addresses with deployment permission.
   */
  async function filterOutPrivilegedUsers(worldName: string, identities: string[]): Promise<string[]> {
    const [owner, permissionRecords] = await Promise.all([
      permissionsManager.getOwner(worldName),
      permissionsManager.getWorldPermissionRecords(worldName)
    ])

    const deployers = permissionRecords
      .filter((record) => record.permissionType === 'deployment')
      .map((record) => record.address.toLowerCase())

    const privileged = new Set([...(owner ? [owner.toLowerCase()] : []), ...deployers])

    return identities.filter((identity) => !privileged.has(identity.toLowerCase()))
  }

  return {
    async handleAccessChange(
      worldName: string,
      previousAccess: AccessSetting,
      newAccess: AccessSetting
    ): Promise<void> {
      const allIdentities = peersRegistry.getPeersInWorld(worldName) ?? []
      if (allIdentities.length === 0) {
        logger.debug(`No participants in world, skipping access change reaction`, { worldName })
        return
      }

      const action: AccessChangeAction =
        TRANSITION_MATRIX[previousAccess.type]?.[newAccess.type]?.(previousAccess, newAccess) ??
        AccessChangeAction.KickAll

      // For actions that involve kicking, filter out the owner and deployers first
      const identities =
        action === AccessChangeAction.NoKick ? allIdentities : await filterOutPrivilegedUsers(worldName, allIdentities)

      if (identities.length === 0) {
        logger.debug(`All participants are privileged users, no kicks needed`, { worldName })
        return
      }

      try {
        await reactions[action].apply(worldName, identities, accessChecker)
      } catch (error) {
        logger.error(`Error applying access change`, {
          worldName,
          previousType: previousAccess.type,
          newType: newAccess.type,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
