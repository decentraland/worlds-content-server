import { AccessToken, Room, RoomServiceClient, VideoGrant, WebhookEvent, WebhookReceiver } from 'livekit-server-sdk'
import { chunks } from '../../logic/utils'
import {
  AppComponents,
  CreateConnectionTokenOptions,
  ListRoomsWithParticipantCountsOptions,
  LivekitClient,
  RoomParticipantCount
} from '../../types'
import { DEFAULT_CONNECTION_TOKEN_TTL_SECONDS, LIST_ROOMS_PARTICIPANT_CHUNK_SIZE } from './constants'

export async function createLivekitClient({ config }: Pick<AppComponents, 'config'>): Promise<LivekitClient> {
  const host = await config.requireString('LIVEKIT_HOST')
  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')
  const apiHost = await config.getString('LIVEKIT_API_HOST')

  const endpoints = normalizeLivekitEndpoints(host, apiHost)

  const receiver = new WebhookReceiver(apiKey, apiSecret)
  const roomService = new RoomServiceClient(endpoints.apiHost, apiKey, apiSecret)

  return {
    async getRoom(roomId: string): Promise<Room | null> {
      const rooms = await roomService.listRooms([roomId])
      return rooms[0] ?? null
    },

    async listRooms(roomNames?: string[]): Promise<Room[]> {
      return roomService.listRooms(roomNames ?? [])
    },

    async listRoomsWithParticipantCounts(
      options?: ListRoomsWithParticipantCountsOptions
    ): Promise<RoomParticipantCount[]> {
      const allRooms = await roomService.listRooms([])
      let roomNames = allRooms.map((room) => room.name)
      const namePrefix = options?.namePrefix
      if (namePrefix) {
        roomNames = roomNames.filter((name) => name.startsWith(namePrefix))
      }
      if (roomNames.length === 0) return []
      const chunkSize = options?.chunkSize ?? LIST_ROOMS_PARTICIPANT_CHUNK_SIZE
      const chunkedNames = chunks(roomNames, chunkSize)
      const results = await Promise.all(chunkedNames.map((names) => roomService.listRooms(names)))
      return results.flat().map((room) => ({
        name: room.name,
        numParticipants: room.numParticipants ?? 0
      }))
    },

    async createConnectionToken(
      identity: string,
      grant: VideoGrant,
      options?: CreateConnectionTokenOptions
    ): Promise<string> {
      const ttl = options?.ttl ?? DEFAULT_CONNECTION_TOKEN_TTL_SECONDS
      const token = new AccessToken(apiKey, apiSecret, {
        identity: identity.toLowerCase(),
        ttl
      })
      token.addGrant(grant)
      const jwt = await token.toJwt()
      return `livekit:${endpoints.clientHost}?access_token=${jwt}`
    },

    receiveWebhookEvent: async (body: string, authorization: string): Promise<WebhookEvent> => {
      return receiver.receive(body, authorization)
    },

    async removeParticipant(roomName: string, identity: string): Promise<void> {
      await roomService.removeParticipant(roomName, identity)
    }
  }
}

function normalizeLivekitEndpoints(
  clientHost: string,
  configuredApiHost?: string
): {
  clientHost: string
  apiHost: string
} {
  if (!clientHost) {
    return { clientHost, apiHost: configuredApiHost || clientHost }
  }

  const clientUrl = clientHost.includes('://') ? clientHost : `wss://${clientHost}`
  const parsed = new URL(clientUrl)
  const apiHost = configuredApiHost || `${parsed.protocol === 'ws:' ? 'http:' : 'https:'}//${parsed.host}`

  return { clientHost: clientUrl, apiHost }
}
