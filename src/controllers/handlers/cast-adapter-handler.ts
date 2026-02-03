import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { AccessToken } from 'livekit-server-sdk'
import { InvalidRequestError, NotFoundError } from '@dcl/http-commons'

export async function castAdapterHandler(
  context: HandlerContextWithPath<
    'config' | 'namePermissionChecker' | 'permissions' | 'worlds',
    '/meet-adapter/:roomId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, namePermissionChecker, permissions, worlds }
  } = context

  const [host, apiKey, apiSecret] = await Promise.all([
    config.requireString('LIVEKIT_HOST'),
    config.requireString('LIVEKIT_API_KEY'),
    config.requireString('LIVEKIT_API_SECRET')
  ])

  if (!validateMetadata(context.verification!.authMetadata)) {
    throw new InvalidRequestError('Access denied, invalid metadata')
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  if (!context.params.roomId.startsWith(roomPrefix)) {
    throw new InvalidRequestError('Invalid room id requested.')
  }

  const worldName = context.params.roomId.substring(roomPrefix.length)

  if (!(await worlds.isWorldValid(worldName))) {
    throw new NotFoundError(`World "${worldName}" was not found.`)
  }

  const identity = context.verification!.auth
  const hasPermission =
    (await namePermissionChecker.checkPermission(identity, worldName)) ||
    (await permissions.hasWorldWidePermission(worldName, 'streaming', identity))

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: 5 * 60 // 5 minutes
  })
  token.addGrant({
    roomJoin: true,
    room: context.params.roomId,
    roomList: false,
    canSubscribe: true,
    canPublishData: hasPermission,
    canPublish: hasPermission
  })
  return {
    status: 200,
    body: {
      url: `wss://${host}`,
      token: await token.toJwt()
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
