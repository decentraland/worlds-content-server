import { AppComponents, CommsStatus, ICommsAdapter, WorldStatus } from '../types'
import { AccessToken, Room, RoomServiceClient } from 'livekit-server-sdk'
import { EthAddress } from '@dcl/schemas'
import LRU from 'lru-cache'

export async function createCommsAdapterComponent({
  config,
  fetch,
  logs
}: Pick<AppComponents, 'config' | 'fetch' | 'logs'>): Promise<ICommsAdapter> {
  const logger = logs.getLogger('comms-adapter')

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const adapterType = await config.requireString('COMMS_ADAPTER')
  switch (adapterType) {
    case 'ws-room':
      const fixedAdapter = await config.requireString('COMMS_FIXED_ADAPTER')
      logger.info(`Using ws-room-service adapter with template baseUrl: ${fixedAdapter}`)
      return cachingAdapter({ logs }, createWsRoomAdapter({ fetch }, roomPrefix, fixedAdapter))

    case 'livekit':
      const host = await config.requireString('LIVEKIT_HOST')
      logger.info(`Using livekit adapter with host: ${host}`)
      const apiKey = await config.requireString('LIVEKIT_API_KEY')
      const apiSecret = await config.requireString('LIVEKIT_API_SECRET')
      return cachingAdapter({ logs }, createLiveKitAdapter(roomPrefix, host, apiKey, apiSecret))

    default:
      throw Error(`Invalid comms adapter: ${adapterType}`)
  }
}

function createWsRoomAdapter(
  { fetch }: Pick<AppComponents, 'fetch'>,
  roomPrefix: string,
  fixedAdapter: string
): ICommsAdapter {
  return {
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
              .filter((room: any) => room.roomName.startsWith(roomPrefix) && room.count > 0)
              .map((room: { roomName: string; count: number }): WorldStatus => {
                const { roomName, count } = room
                return { worldName: roomName.substring(roomPrefix.length), users: count }
              }),
            timestamp: Date.now()
          })
        )
    },
    connectionString: async function (userId: EthAddress, roomId: string): Promise<string> {
      const roomsUrl = fixedAdapter.replace(/rooms\/.*/, 'rooms')
      return `${roomsUrl}/${roomId}`
    }
  }
}

function createLiveKitAdapter(roomPrefix: string, host: string, apiKey: string, apiSecret: string): ICommsAdapter {
  return {
    async status(): Promise<CommsStatus> {
      const roomService = new RoomServiceClient(`https://${host}`, apiKey, apiSecret)
      const rooms = await roomService.listRooms()

      const worldRoomNames = rooms
        .filter((room: Room) => room.name.startsWith(roomPrefix))
        .map((room: Room) => room.name)

      const roomWithUsers = await Promise.all(
        worldRoomNames.map(async (roomName: string) => {
          return await roomService
            .listParticipants(roomName)
            .then((participants) => {
              return { worldName: roomName.substring(roomPrefix.length), users: participants.length }
            })
            .catch((error) => {
              console.log(error)
              return { worldName: roomName.substring(roomPrefix.length), users: 0 }
            })
        })
      )

      return {
        adapterType: 'livekit',
        statusUrl: `https://${host}/`,
        rooms: roomWithUsers.length,
        users: roomWithUsers.reduce((carry: number, value: WorldStatus) => carry + value.users, 0),
        details: roomWithUsers,
        timestamp: Date.now()
      }
    },

    async connectionString(userId: string, roomId: string, name: string | undefined = undefined): Promise<string> {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: userId,
        name,
        ttl: 5 * 60 // 5 minutes
      })
      token.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true })
      return `livekit:wss://${host}?access_token=${token.toJwt()}`
    }
  }
}

function cachingAdapter({ logs }: Pick<AppComponents, 'logs'>, wrappedAdapter: ICommsAdapter): ICommsAdapter {
  const logger = logs.getLogger('caching-comms-adapter')

  const CACHE_KEY = 'comms_status'
  const cache = new LRU<string, CommsStatus>({
    max: 1,
    ttl: 60 * 1000, // cache for 1 minute
    fetchMethod: async (_, staleValue): Promise<CommsStatus> => {
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

    async connectionString(userId: EthAddress, roomId: string): Promise<string> {
      return wrappedAdapter.connectionString(userId, roomId)
    }
  }
}
