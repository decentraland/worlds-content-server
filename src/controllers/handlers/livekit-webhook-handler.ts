import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/http-commons'
import { ParticipantEvent, WebhookEventName } from '../../adapters/livekit-client'

const TOPIC_SUFFIX_BY_EVENT = {
  [WebhookEventName.ParticipantJoined]: 'join',
  [WebhookEventName.ParticipantLeft]: 'leave'
}

function isValidEvent(event: string): event is ParticipantEvent {
  return Object.values(WebhookEventName).includes(event as WebhookEventName)
}

// TODO: refactor this to be like the one in Comms Gatekeeper (might be a good idea for a new component in core-components)
export async function livekitWebhookHandler(
  ctx: HandlerContextWithPath<'nats' | 'logs' | 'livekitClient' | 'peersRegistry', '/livekit-webhook'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { nats, logs, livekitClient, peersRegistry },
    request
  } = ctx

  const peerRegistryHandlerByEvent: Record<ParticipantEvent, (identity: string, roomName: string) => void> = {
    [WebhookEventName.ParticipantJoined]: peersRegistry.onPeerConnected,
    [WebhookEventName.ParticipantLeft]: peersRegistry.onPeerDisconnected
  }

  const logger = logs.getLogger('livekit-webhook')

  const body = await request.text()
  const authorization = request.headers.get('Authorization') || ''

  if (!authorization) {
    throw new InvalidRequestError('Authorization header not found')
  }

  const { event, participant, room } = await livekitClient.receiveWebhookEvent(body, authorization)

  if (!participant?.identity) {
    throw new InvalidRequestError('Participant identity not found')
  }

  if (!room?.name) {
    throw new InvalidRequestError('Room name not found')
  }

  if (!isValidEvent(event) || !room.name.endsWith('.dcl.eth')) {
    logger.debug('Skipping event', { event, roomName: room.name })
    return {
      status: 200,
      body: { message: 'Skipping event' }
    }
  }

  const { identity } = participant

  logger.debug(`Publishing event ${event} for participant ${identity} in room ${room.name}`)

  nats.publish(`peer.${identity}.world.${TOPIC_SUFFIX_BY_EVENT[event]}`)

  const peerRegistryHandler = peerRegistryHandlerByEvent[event]
  peerRegistryHandler(identity, room.name)

  return {
    status: 200,
    body
  }
}
