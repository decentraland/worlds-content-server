import { AccessToken, Room, RoomServiceClient, VideoGrant, WebhookEvent, WebhookReceiver } from 'livekit-server-sdk'
import { AppComponents, CreateConnectionTokenOptions, LivekitClient } from '../../types'
import { DEFAULT_CONNECTION_TOKEN_TTL_SECONDS } from './constants'

export async function createLivekitClient({ config }: Pick<AppComponents, 'config'>): Promise<LivekitClient> {
  const host = await config.requireString('LIVEKIT_HOST')
  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  const receiver = new WebhookReceiver(apiKey, apiSecret)
  const roomService = new RoomServiceClient(`https://${host}`, apiKey, apiSecret)

  return {
    async listRooms(roomNames?: string[]): Promise<Room[]> {
      return roomService.listRooms(roomNames ?? [])
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
      return `livekit:wss://${host}?access_token=${jwt}`
    },

    receiveWebhookEvent: async (body: string, authorization: string): Promise<WebhookEvent> => {
      return receiver.receive(body, authorization)
    }
  }
}
