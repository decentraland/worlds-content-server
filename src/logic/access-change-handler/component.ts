import { AccessChangeAction, IAccessChangeHandler } from './types'
import { type AccessSetting, AccessType } from '../access/types'
import { allowListChanged, secretChanged } from './utils'
import { AppComponents } from '../../types'

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
      await participantKicker.kickParticipants(worldName, identities)
    }
  }
}

function createKickWithoutAccessReaction({
  participantKicker,
  logs,
  accessChecker
}: Pick<AppComponents, 'participantKicker' | 'logs' | 'accessChecker'>): AccessChangeReaction {
  const logger = logs.getLogger('kick-without-access-reaction')

  return {
    async apply(worldName: string, identities: string[]): Promise<void> {
      if (identities.length === 0) return

      const accessResults = await Promise.all(
        identities.map(async (identity) => {
          try {
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
    [AccessChangeAction.KickAllParticipants]: createKickAllReaction({ participantKicker, logs }),
    [AccessChangeAction.KickParticipantsWithoutAccess]: createKickWithoutAccessReaction({
      participantKicker,
      logs,
      accessChecker
    })
  }

  // Sorting matters here, as the first condition that matches will be used
  const actionRules = [
    {
      condition: (_prev: AccessSetting, next: AccessSetting) => next.type === AccessType.Unrestricted,
      action: AccessChangeAction.NoKick
    },
    {
      condition: (prev: AccessSetting, next: AccessSetting) => prev.type !== next.type || secretChanged(prev, next),
      action: AccessChangeAction.KickAllParticipants
    },
    {
      condition: (prev: AccessSetting, next: AccessSetting) => allowListChanged(prev, next),
      action: AccessChangeAction.KickParticipantsWithoutAccess
    }
  ]

  function resolveAction(previousAccess: AccessSetting, newAccess: AccessSetting): AccessChangeAction {
    return (
      actionRules.find(({ condition }) => condition(previousAccess, newAccess))?.action ?? AccessChangeAction.NoKick
    )
  }

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

      const action = resolveAction(previousAccess, newAccess)

      const identities =
        action === AccessChangeAction.NoKick ? allIdentities : await filterOutPrivilegedUsers(worldName, allIdentities)

      if (identities.length === 0) {
        logger.debug(`All participants are privileged users, no kicks needed`, { worldName })
        return
      }

      try {
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
