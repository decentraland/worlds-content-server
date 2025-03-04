import { WebhookReceiver } from 'livekit-server-sdk'
import { AppComponents, LivekitClient } from '../types'

export enum WebhookEventName {
  ParticipantJoined = 'participant_joined',
  ParticipantLeft = 'participant_left'
}

export type ParticipantEvent = WebhookEventName.ParticipantJoined | WebhookEventName.ParticipantLeft

export async function createLivekitClient({ config }: Pick<AppComponents, 'config'>): Promise<LivekitClient> {
  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  const receiver = new WebhookReceiver(apiKey, apiSecret)

  return {
    receiveWebhookEvent: async (body: string, authorization: string) => {
      return receiver.receive(body, authorization)
    }
  }
}
