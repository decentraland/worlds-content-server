import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { WebhookReceiver } from 'livekit-server-sdk'
import { IHttpServerComponent } from '@well-known-components/interfaces'

enum WebhookEvent {
  ParticipantJoined = 'participant_joined',
  ParticipantLeft = 'participant_left'
}

const TOPIC_SUFFIX_BY_EVENT = {
  [WebhookEvent.ParticipantJoined]: 'join',
  [WebhookEvent.ParticipantLeft]: 'leave'
}

function isValidEvent(event: string): event is keyof typeof WebhookEvent {
  return Object.values(WebhookEvent).includes(event as WebhookEvent)
}

export async function livekitWebhookHandler(
  ctx: HandlerContextWithPath<'nats' | 'config' | 'logs', '/livekit-webhook'> & DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { nats, config, logs },
    request
  } = ctx

  const logger = logs.getLogger('livekit-webhook')

  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  try {
    const body = await request.text()
    const authorization = request.headers.get('Authorization') || ''

    if (!authorization) {
      return {
        status: 400,
        body: { message: 'Authorization header not found' }
      }
    }

    const receiver = new WebhookReceiver(apiKey, apiSecret)
    const { event, room, participant } = await receiver.receive(body, authorization)

    if (!participant?.identity) {
      return {
        status: 400,
        body: { message: 'Participant identity not found' }
      }
    }

    if (!room?.name) {
      return {
        status: 400,
        body: { message: 'Room name not found' }
      }
    }

    if (!isValidEvent(event) || !room.name.endsWith('.dcl.eth')) {
      logger.info('Skipping event', { event, roomName: room.name })
      return {
        status: 200,
        body: { message: 'Skipping event' }
      }
    }

    const { identity } = participant

    logger.debug(`Publishing event ${event} for participant ${identity} in room ${room.name}`)
    nats.publish(`peer.${identity}.world.${TOPIC_SUFFIX_BY_EVENT[event]}`)

    return {
      status: 200,
      body
    }
  } catch (error: any) {
    return {
      status: 500,
      body: {
        message: 'Error receiving livekit webhook',
        error: error.message
      }
    }
  }
}
