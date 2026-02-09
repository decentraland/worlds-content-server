import { AccessChangeAction, IAccessChangeHandler } from './types'
import type { AccessSetting } from '../access/types'
import { TRANSITION_MATRIX } from './constants'
import { AppComponents } from '../../types'

/** Internal: reaction to an access change (no-op or kick all). */
interface AccessChangeReaction {
  apply(worldName: string, identities: string[]): Promise<void>
}

function createNoKickReaction({ logs }: Pick<AppComponents, 'logs'>): AccessChangeReaction {
  const logger = logs.getLogger('no-kick-reaction')

  return {
    async apply(_worldName, _identities): Promise<void> {
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
    async apply(worldName, identities): Promise<void> {
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
 * Creates the access change handler. Selects the reaction for an access type
 * transition via TRANSITION_MATRIX; fetches participants, exits when none, then
 * applies the reaction (no-op or kick all).
 */
export function createAccessChangeHandler({
  peersRegistry,
  participantKicker,
  logs
}: Pick<AppComponents, 'peersRegistry' | 'participantKicker' | 'logs'>): IAccessChangeHandler {
  const logger = logs.getLogger('access-change-handler')
  const reactions: Record<AccessChangeAction, AccessChangeReaction> = {
    noKick: createNoKickReaction({ logs }),
    kickAll: createKickAllReaction({ participantKicker, logs })
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

      try {
        const action: AccessChangeAction =
          TRANSITION_MATRIX[previousAccess.type]?.[newAccess.type] ?? 'kickAll'
        await reactions[action].apply(worldName, identities)
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
