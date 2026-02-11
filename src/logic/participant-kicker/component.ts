import { AppComponents } from '../../types'
import { IParticipantKicker } from './types'
import { DEFAULT_KICK_BATCH_SIZE } from './constants'

export async function createParticipantKicker(
  deps: Pick<AppComponents, 'peersRegistry' | 'commsAdapter' | 'logs' | 'config'>
): Promise<IParticipantKicker> {
  const { peersRegistry, commsAdapter, logs, config } = deps
  const logger = logs.getLogger('participant-kicker')
  const kickBatchSize = (await config.getNumber('ACCESS_KICK_BATCH_SIZE')) ?? DEFAULT_KICK_BATCH_SIZE

  async function kickParticipants(worldName: string, identities: string[]): Promise<void> {
    if (identities.length === 0) return

    logger.info(`Kicking ${identities.length} participant(s) from world ${worldName}`, {
      worldName,
      participantCount: identities.length
    })

    for (let i = 0; i < identities.length; i += kickBatchSize) {
      const batch = identities.slice(i, i + kickBatchSize)
      const results = await Promise.allSettled(
        batch.map(async (identity) => {
          const rooms = peersRegistry.getPeerRooms(identity)
          if (rooms.length === 0) {
            logger.debug(`Peer not in any rooms, skipping`, { worldName, identity })
            return
          }
          const kickResults = await Promise.allSettled(
            rooms.map(async (roomName) => {
              try {
                await commsAdapter.removeParticipant(roomName, identity)
                logger.debug(`Kicked participant from room`, { worldName, roomName, identity })
              } catch (error) {
                logger.warn(`Failed to kick participant from room`, {
                  worldName,
                  roomName,
                  identity,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            })
          )
          const kickFailures = kickResults.filter((r) => r.status === 'rejected')
          if (kickFailures.length > 0) {
            logger.warn(`Failed to kick participant from ${kickFailures.length}/${rooms.length} room(s)`, {
              worldName,
              identity,
              totalRooms: rooms.length,
              failedRooms: kickFailures.length
            })
            throw new Error(`Failed to kick from ${kickFailures.length} room(s)`)
          }
        })
      )
      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length > 0) {
        logger.warn(`Batch completed with ${failures.length} failure(s)`, {
          worldName,
          batchSize: batch.length,
          failures: failures.length
        })
      }
    }

    logger.info(`Completed kicking participants from world ${worldName}`, {
      worldName,
      totalKicked: identities.length
    })
  }

  return {
    kickParticipants,
    async kickParticipant(worldName: string, identity: string): Promise<void> {
      await kickParticipants(worldName, [identity])
    }
  }
}
