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
      await participantKicker.kickInBatches(worldName, identities)
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

      const identitiesWithoutAccess: string[] = []
      for (const identity of identities) {
        try {
          const hasAccess = await accessChecker.checkAccess(worldName, identity)
          if (!hasAccess) identitiesWithoutAccess.push(identity)
        } catch (error) {
          logger.warn(`Error checking access for identity, will not kick`, {
            worldName,
            identity,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      if (identitiesWithoutAccess.length === 0) {
        logger.debug(`All participants still have access, no kicks`, { worldName })
        return
      }

      logger.info(`Kicking participants without access after allow-list change`, {
        worldName,
        participantCount: identitiesWithoutAccess.length
      })
      await participantKicker.kickInBatches(worldName, identitiesWithoutAccess)
    }
  }
}

/**
 * Creates the access change handler. Selects the reaction from the transition
 * matrix (entries may be direct actions or resolvers for same-type transitions)
 * and applies it. Requires accessChecker so kickWithoutAccess can run when
 * AllowList lists change.
 */
export function createAccessChangeHandler({
  peersRegistry,
  participantKicker,
  logs,
  accessChecker
}: Pick<AppComponents, 'peersRegistry' | 'participantKicker' | 'logs' | 'accessChecker'>): IAccessChangeHandler {
  const logger = logs.getLogger('access-change-handler')
  const reactions: Record<AccessChangeAction, AccessChangeReaction> = {
    noKick: createNoKickReaction({ logs }),
    kickAll: createKickAllReaction({ participantKicker, logs }),
    kickWithoutAccess: createKickWithoutAccessReaction({ participantKicker, logs })
  }

  return {
    async handleAccessChange(
      worldName: string,
      previousAccess: AccessSetting,
      newAccess: AccessSetting
    ): Promise<void> {
      const identities = peersRegistry.getPeersInWorld(worldName)
      if (identities.length === 0) {
        logger.debug(`No participants in world, skipping access change reaction`, { worldName })
        return
      }

      const entry = TRANSITION_MATRIX[previousAccess.type]?.[newAccess.type] ?? 'kickAll'
      const action: AccessChangeAction = typeof entry === 'function' ? entry(previousAccess, newAccess) : entry

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
