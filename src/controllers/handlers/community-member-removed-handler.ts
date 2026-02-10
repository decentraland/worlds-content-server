import { CommunityMemberBannedEvent, CommunityMemberLeftEvent, CommunityMemberRemovedEvent, Events } from '@dcl/schemas'
import { AccessType } from '../../logic/access/types'
import { AppComponents } from '../../types'

/**
 * Union of the community member events this handler processes.
 */
type CommunityMemberRemovedEventPayload =
  | CommunityMemberRemovedEvent
  | CommunityMemberBannedEvent
  | CommunityMemberLeftEvent

export interface ICommunityMemberRemovedHandler {
  handle(event: CommunityMemberRemovedEventPayload): Promise<void>
}

/**
 * Creates the community member removed handler.
 *
 * When a user leaves, is removed, or is banned from a community, this handler:
 * 1. Checks if the user is currently connected to any world (peersRegistry)
 * 2. For that world, re-validates the user's access (they might still have access via wallet or another community)
 * 3. Kicks the user if they no longer have access
 */
export function createCommunityMemberRemovedHandler({
  peersRegistry,
  accessChecker,
  participantKicker,
  logs
}: Pick<
  AppComponents,
  'peersRegistry' | 'accessChecker' | 'participantKicker' | 'logs'
>): ICommunityMemberRemovedHandler {
  const logger = logs.getLogger('community-member-removed-handler')

  async function handle(event: CommunityMemberRemovedEventPayload): Promise<void> {
    const { id: communityId, memberAddress } = event.metadata

    logger.info(`Processing community member event`, {
      communityId,
      memberAddress,
      subType: event.subType
    })

    const worldName = peersRegistry.getPeerWorld(memberAddress)
    if (!worldName) {
      logger.debug(`Member not connected to any world, skipping`, { memberAddress })
      return
    }

    try {
      const worldAccess = await accessChecker.getWorldAccess(worldName)
      if (worldAccess.type !== AccessType.AllowList) {
        logger.debug(`World access is not allowlist, skipping re-check and kick`, {
          worldName,
          memberAddress,
          accessType: worldAccess.type
        })
        return
      }

      const hasAccess = await accessChecker.checkAccess(worldName, memberAddress)
      if (hasAccess) {
        logger.debug(`Member still has access to world, skipping kick`, {
          worldName,
          memberAddress
        })
        return
      }

      logger.info(`Kicking member who lost community-based access`, { worldName, memberAddress })
      await participantKicker.kickParticipant(worldName, memberAddress)
    } catch (error) {
      logger.error(`Error processing community member event`, {
        worldName,
        communityId,
        memberAddress,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { handle }
}

/**
 * The community event subtypes this handler subscribes to.
 */
export const COMMUNITY_MEMBER_REMOVED_EVENT_SUBTYPES = [
  Events.SubType.Community.MEMBER_REMOVED,
  Events.SubType.Community.MEMBER_BANNED,
  Events.SubType.Community.MEMBER_LEFT
] as const
