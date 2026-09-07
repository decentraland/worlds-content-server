import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidRequestError } from '@dcl/http-commons'
import { ParticipantEvent, WebhookEventName } from '../../adapters/livekit-client'

const TOPIC_SUFFIX_BY_EVENT = {
  [WebhookEventName.ParticipantJoined]: 'join',
  [WebhookEventName.ParticipantLeft]: 'leave'
}

function isValidEvent(event: string): event is ParticipantEvent {
  return Object.values(WebhookEventName).includes(event as WebhookEventName)
}

/** The values that switch the publish off. Anything else — an absent value included — keeps it on. */
const PUBLISH_DISABLING_VALUES = new Set(['false', '0', 'no'])

/**
 * Reads `PUBLISH_PEER_WORLD_EVENTS` the same way `PRESENCE_SOURCE` is read: trimmed and
 * case-insensitive. At rollout step 8 an operator flips this flag off while social-service-ea is
 * already reading world presence from Pulse, and a Helm value is quite easily `FALSE`, `0` or
 * `false ` with a trailing space — comparing against the exact string `false` would have kept
 * publishing, delivering every world join/leave twice while the dashboard showed the flag flipped.
 */
function shouldPublishPeerWorldEvents(configured: string | undefined): boolean {
  return configured === undefined || !PUBLISH_DISABLING_VALUES.has(configured.trim().toLowerCase())
}

// TODO: refactor this to be like the one in Comms Gatekeeper (might be a good idea for a new component in core-components)
export async function livekitWebhookHandler(
  ctx: HandlerContextWithPath<'config' | 'nats' | 'logs' | 'livekitClient' | 'peersRegistry', '/livekit-webhook'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, nats, logs, livekitClient, peersRegistry },
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

  // Iteration 2, rollout step 8: this publish — and with it the `nats` dependency — is deleted once
  // social-service-ea reads world presence from Pulse. Absent configuration means `true`, so the
  // default behaviour is exactly today's.
  const publishPeerWorldEvents = shouldPublishPeerWorldEvents(await config.getString('PUBLISH_PEER_WORLD_EVENTS'))

  if (publishPeerWorldEvents) {
    logger.debug(`Publishing event ${event} for participant ${identity} in room ${room.name}`)
    nats.publish(`peer.${identity}.world.${TOPIC_SUFFIX_BY_EVENT[event]}`)
  }

  // Unconditional: the registry is what kicks (participant-kicker) and access changes read.
  const peerRegistryHandler = peerRegistryHandlerByEvent[event]
  peerRegistryHandler(identity, room.name)

  return {
    status: 200,
    body
  }
}
