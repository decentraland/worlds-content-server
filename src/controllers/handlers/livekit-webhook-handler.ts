import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { WebhookReceiver } from 'livekit-server-sdk'
import { IHttpServerComponent } from '@well-known-components/interfaces'

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
    const receiver = new WebhookReceiver(apiKey, apiSecret)

    const body = await request.text()
    const authorization = request.headers.get('Authorization') || ''

    if (!authorization) {
      logger.error('Authorization header not found')
      return {
        status: 400,
        body: 'Authorization header not found'
      }
    }

    logger.debug('Received livekit event with:', { body, authorization })

    const { event, room, participant } = await receiver.receive(body, authorization)

    logger.debug('Livekit event:', { event: JSON.stringify({ event, room, participant }) })

    if (!participant?.identity) {
      logger.error('Participant identity not found')
      return {
        status: 400,
        body: 'Participant identity not found'
      }
    }

    if (!room?.name) {
      logger.error('Room name not found')
      return {
        status: 400,
        body: 'Room name not found'
      }
    }

    if (!['participant_joined', 'participant_left'].includes(event)) {
      logger.info('Skipping event', { event })
      return {
        status: 200,
        body: 'Skipping event'
      }
    }

    const { identity } = participant
    const { name: worldName } = room

    if (event === 'participant_joined') {
      logger.info('Participant joined room', { identity, worldName })
      nats.publish(`peer.${identity}.world.join`)
    }

    if (event === 'participant_left') {
      logger.info('Participant left room', { identity, worldName })
      nats.publish(`peer.${identity}.world.leave`)
    }

    return {
      status: 200,
      body
    }
  } catch (error: any) {
    logger.error('Error receiving livekit webhook', { error: error.message })
    return {
      status: 500,
      body: 'Error receiving livekit webhook'
    }
  }
}
