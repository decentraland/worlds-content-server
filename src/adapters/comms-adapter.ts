import { AppComponents, CommsStatus, ICommsAdapter, LivekitClient, WorldStatus } from '../types'
import { EthAddress } from '@dcl/schemas'
import { TrackSource, VideoGrant } from 'livekit-server-sdk'
import { LRUCache } from 'lru-cache'
import { chunks } from '../logic/utils'

export async function createCommsAdapterComponent({
  config,
  fetch,
  logs,
  livekitClient
}: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'livekitClient'>): Promise<ICommsAdapter> {
  const logger = logs.getLogger('comms-adapter')

  const worldRoomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const sceneRoomPrefix = await config.requireString('SCENE_ROOM_PREFIX')
  const adapterType = await config.requireString('COMMS_ADAPTER')
  switch (adapterType) {
    case 'ws-room':
      const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
      logger.info(`Using ws-room-service adapter with template baseUrl: ${fixedAdapter}`)
      return cachingAdapter({ logs }, createWsRoomAdapter({ fetch }, worldRoomPrefix, sceneRoomPrefix, fixedAdapter))

    case 'livekit':
      const host = await config.requireString('LIVEKIT_HOST')
      logger.info(`Using livekit adapter with host: ${host}`)
      return cachingAdapter(
        { logs },
        createLiveKitAdapter({ logs }, worldRoomPrefix, sceneRoomPrefix, host, livekitClient)
      )

    default:
      throw Error(`Invalid comms adapter: ${adapterType}`)
  }
}

function createWsRoomAdapter(
  { fetch }: Pick<AppComponents, 'fetch'>,
  worldRoomPrefix: string,
  sceneRoomPrefix: string,
  fixedAdapter: string
): ICommsAdapter {
  const adapter: ICommsAdapter = {
    async status(): Promise<CommsStatus> {
      const url = fixedAdapter.substring(fixedAdapter.indexOf(':') + 1)
      const urlWithProtocol =
        !url.startsWith('ws:') && !url.startsWith('wss:') ? 'https://' + url : url.replace(/ws\[s]?:/, 'https')
      const statusUrl = urlWithProtocol.replace(/rooms\/.*/, 'status')

      return await fetch
        .fetch(statusUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then((response) => response.json())
        .then(
          (res: any): CommsStatus => ({
            adapterType: 'ws-room',
            statusUrl,
            commitHash: res.commitHash,
            rooms: res.rooms,
            users: res.users,
            details: res.details
              .filter((room: any) => room.roomName.startsWith(worldRoomPrefix) && room.count > 0)
              .map((room: { roomName: string; count: number }): WorldStatus => {
                const { roomName, count } = room
                return { worldName: roomName.substring(worldRoomPrefix.length), users: count }
              }),
            timestamp: Date.now()
          })
        )
    },
    async getWorldRoomConnectionString(_userId: EthAddress, worldName: string): Promise<string> {
      const roomsUrl = fixedAdapter.replace(/rooms\/.*/, 'rooms')
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      return `${roomsUrl}/${roomId}`
    },
    async getSceneRoomConnectionString(_userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      const roomsUrl = fixedAdapter.replace(/rooms\/.*/, 'rooms')
      const roomId = `${sceneRoomPrefix}${worldName.toLowerCase()}-${sceneId.toLowerCase()}`
      return `${roomsUrl}/${roomId}`
    },
    async getRoomParticipantCount(worldName: string): Promise<number> {
      const s = await adapter.status()
      const normalized = worldName.toLowerCase()
      const detail = s.details?.find((d) => d.worldName.toLowerCase() === normalized)
      return detail?.users ?? 0
    }
  }
  return adapter
}

function createLiveKitAdapter(
  { logs }: Pick<AppComponents, 'logs'>,
  worldRoomPrefix: string,
  sceneRoomPrefix: string,
  host: string,
  livekitClient: LivekitClient
): ICommsAdapter {
  const logger = logs.getLogger('livekit-adapter')

  function buildWorldRoomGrant(roomId: string): VideoGrant {
    return {
      roomJoin: true,
      room: roomId,
      roomList: false,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: [TrackSource.MICROPHONE]
    }
  }

  return {
    async status(): Promise<CommsStatus> {
      try {
        const allRooms = await livekitClient.listRooms()
        const worldRoomNames = allRooms.filter((room) => room.name.startsWith(worldRoomPrefix)).map((room) => room.name)

        const LIST_ROOMS_PARTICIPANT_LIMIT = 10
        const roomsWithUsers: WorldStatus[] = (
          await Promise.all(
            chunks(worldRoomNames, LIST_ROOMS_PARTICIPANT_LIMIT).map(
              async (chunkedRoomNames: string[]): Promise<WorldStatus[]> => {
                try {
                  const rooms = await livekitClient.listRooms(chunkedRoomNames)
                  return rooms.map((room) => ({
                    worldName: room.name.substring(worldRoomPrefix.length),
                    users: room.numParticipants
                  }))
                } catch (error) {
                  logger.error(`Error retrieving comms status for chunk: ${(error as Error).message}`)
                  return chunkedRoomNames.map((worldRoomName) => ({
                    worldName: worldRoomName.substring(worldRoomPrefix.length),
                    users: 0
                  }))
                }
              }
            )
          )
        )
          .flat()
          .filter((room) => room.users > 0)

        return {
          adapterType: 'livekit',
          statusUrl: `https://${host}/`,
          rooms: roomsWithUsers.length,
          users: roomsWithUsers.reduce((carry, value) => carry + value.users, 0),
          details: roomsWithUsers,
          timestamp: Date.now()
        }
      } catch (error) {
        logger.error(`Error retrieving comms status: ${(error as Error).message}`)
        return {
          adapterType: 'livekit',
          statusUrl: `https://${host}/`,
          rooms: 0,
          users: 0,
          details: [],
          timestamp: Date.now()
        }
      }
    },

    async getWorldRoomConnectionString(userId: EthAddress, worldName: string): Promise<string> {
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      return livekitClient.createConnectionToken(userId.toLowerCase(), buildWorldRoomGrant(roomId))
    },

    async getSceneRoomConnectionString(userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      const roomId = `${sceneRoomPrefix}${worldName.toLowerCase()}-${sceneId.toLowerCase()}`
      return livekitClient.createConnectionToken(userId.toLowerCase(), buildWorldRoomGrant(roomId))
    },

    async getRoomParticipantCount(worldName: string): Promise<number> {
      const roomId = `${worldRoomPrefix}${worldName.toLowerCase()}`
      const rooms = await livekitClient.listRooms([roomId])
      return rooms[0]?.numParticipants ?? 0
    }
  }
}

function cachingAdapter({ logs }: Pick<AppComponents, 'logs'>, wrappedAdapter: ICommsAdapter): ICommsAdapter {
  const logger = logs.getLogger('caching-comms-adapter')

  const CACHE_KEY = 'comms_status'
  const cache = new LRUCache<string, CommsStatus>({
    max: 1,
    ttl: 60 * 1000, // cache for 1 minute
    fetchMethod: async (_, staleValue): Promise<CommsStatus | undefined> => {
      try {
        return await wrappedAdapter.status()
      } catch (_: any) {
        logger.warn(`Error retrieving comms status: ${_.message}`)
        return staleValue
      }
    }
  })

  return {
    async status(): Promise<CommsStatus> {
      return (await cache.fetch(CACHE_KEY))!
    },

    getWorldRoomConnectionString(userId: EthAddress, worldName: string): Promise<string> {
      return wrappedAdapter.getWorldRoomConnectionString(userId, worldName)
    },

    getSceneRoomConnectionString(userId: EthAddress, worldName: string, sceneId: string): Promise<string> {
      return wrappedAdapter.getSceneRoomConnectionString(userId, worldName, sceneId)
    },

    async getRoomParticipantCount(worldName: string): Promise<number> {
      const status = await cache.fetch(CACHE_KEY)
      const normalized = worldName.toLowerCase()
      const detail = status?.details?.find((d) => d.worldName.toLowerCase() === normalized)
      return detail?.users ?? 0
    }
  }
}
