import { AppComponents, CommsStatus, ICommsAdapter, WorldStatus } from '../types'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import { EthAddress } from '@dcl/schemas'
import { LRUCache } from 'lru-cache'

function chunk<T>(theArray: T[], size: number): T[][] {
  return theArray.reduce((acc: T[][], _, i) => {
    if (i % size === 0) {
      acc.push(theArray.slice(i, i + size))
    }
    return acc
  }, [])
}

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
      return cachingAdapter({ logs }, createLiveKitAdapter({ fetch }, roomPrefix, host, apiKey, apiSecret))

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

function createLiveKitAdapter(
  { fetch }: Pick<AppComponents, 'fetch'>,
  roomPrefix: string,
  host: string,
  apiKey: string,
  apiSecret: string
): ICommsAdapter {
  return {
    async status(): Promise<CommsStatus> {
      const token = new AccessToken(apiKey, apiSecret, {
        name: 'SuperAdmin',
        ttl: 5 * 60 // 5 minutes
      })
      token.addGrant({ roomList: true })

      const worldRoomNames: string[] = await fetch
        .fetch(`https://${host}/twirp/livekit.RoomService/ListRooms`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.toJwt()}`,
            'Content-Type': 'application/json'
          },
          body: '{}'
        })
        .then((response) => response.json())
        .then((res: any) =>
          res.rooms.filter((room: any) => room.name.startsWith(roomPrefix)).map((room: { name: string }) => room.name)
        )

      // We need to chunk the room names because the ListRooms endpoint
      // only retrieves max_participants for the first 10 rooms
      const roomsWithUsers = (
        await Promise.all(
          chunk(worldRoomNames, 10).map((chunkedRoomNames: string[]): Promise<WorldStatus[]> => {
            return fetch
              .fetch(`https://${host}/twirp/livekit.RoomService/ListRooms`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token.toJwt()}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ names: chunkedRoomNames })
              })
              .then((response) => response.json())
              .then((res: any) => {
                return res.rooms.map(
                  (room: { name: string; num_participants: number }): WorldStatus => ({
                    worldName: room.name.substring(roomPrefix.length),
                    users: room.num_participants
                  })
                )
              })
              .catch((error) => {
                console.log(error)
                return chunkedRoomNames.map(
                  (worldRoomName: string): WorldStatus => ({
                    worldName: worldRoomName.substring(roomPrefix.length),
                    users: 0
                  })
                )
              })
          })
        )
      )
        .flat()
        .filter((room: WorldStatus) => room.users > 0)

      return {
        adapterType: 'livekit',
        statusUrl: `https://${host}/`,
        rooms: roomsWithUsers.length,
        users: roomsWithUsers.reduce((carry: number, value: WorldStatus) => carry + value.users, 0),
        details: roomsWithUsers,
        timestamp: Date.now()
      }
    },

    async connectionString(userId: string, roomId: string, name: string | undefined = undefined): Promise<string> {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: userId,
        name,
        ttl: 5 * 60 // 5 minutes
      })
      token.addGrant({
        roomJoin: true,
        room: roomId,
        roomList: false,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: [TrackSource.MICROPHONE]
      })
      return `livekit:wss://${host}?access_token=${token.toJwt()}`
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

    async connectionString(userId: EthAddress, roomId: string): Promise<string> {
      return wrappedAdapter.connectionString(userId, roomId)
    }
  }
}
