import { UserBanCreatedEvent, Events } from '@dcl/schemas'
import { AppComponents } from '../../types'

export interface IUserBanHandler {
  handle(event: UserBanCreatedEvent): Promise<void>
}

export function createUserBanHandler({
  peersRegistry,
  participantKicker,
  logs
}: Pick<AppComponents, 'peersRegistry' | 'participantKicker' | 'logs'>): IUserBanHandler {
  const logger = logs.getLogger('user-ban-handler')

  async function handle(event: UserBanCreatedEvent): Promise<void> {
    const { bannedAddress } = event.metadata

    logger.info('Processing platform ban event', { bannedAddress })

    const worldName = peersRegistry.getPeerWorld(bannedAddress)
    if (!worldName) {
      logger.debug('Banned user not connected to any world, skipping', { bannedAddress })
      return
    }

    try {
      logger.info('Kicking platform-banned user', { worldName, bannedAddress })
      await participantKicker.kickParticipant(worldName, bannedAddress)
    } catch (error) {
      logger.error('Error kicking platform-banned user', {
        worldName,
        bannedAddress,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { handle }
}

export const USER_BAN_EVENT_SUBTYPE = Events.SubType.Moderation.USER_BAN_CREATED
