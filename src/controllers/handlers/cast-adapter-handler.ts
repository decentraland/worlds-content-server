import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { AccessToken } from 'livekit-server-sdk'
import { assertNotBlockedOrWithinInGracePeriod } from '../../logic/blocked'
import { InvalidRequestError, NotFoundError } from '@dcl/platform-server-commons'

export async function castAdapterHandler(
  context: HandlerContextWithPath<
    'config' | 'nameDenyListChecker' | 'namePermissionChecker' | 'storage' | 'worldsManager',
    '/meet-adapter/:roomId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, nameDenyListChecker, namePermissionChecker, worldsManager }
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

  if (!(await nameDenyListChecker.checkNameDenyList(worldName))) {
    throw new NotFoundError(`World "${worldName}" does not exist.`)
  }

  const worldMetadata = await worldsManager.getMetadataForWorld(worldName)
  if (!worldMetadata) {
    throw new NotFoundError(`World "${worldName}" does not exist.`)
  }

  assertNotBlockedOrWithinInGracePeriod(worldMetadata)

  const identity = context.verification!.auth
  const permissionChecker = await worldsManager.permissionCheckerForWorld(worldName)
  const hasPermission =
    (await namePermissionChecker.checkPermission(identity, worldName)) ||
    (await permissionChecker.checkPermission('streaming', identity))

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
