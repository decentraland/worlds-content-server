import { HandlerContextWithPath, InvalidRequestError, NotFoundError } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext, verify } from '@dcl/platform-crypto-middleware'
import { allowedByAcl } from '../../logic/acl'
import { AccessToken } from 'livekit-server-sdk'

export async function castAdapterHandler(
  context: HandlerContextWithPath<
    'config' | 'storage' | 'namePermissionChecker' | 'worldsManager' | 'fetch',
    '/meet-adapter/:roomId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, storage, fetch }
  } = context

  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')

  const baseUrl = (
    (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`
  ).toString()
  const path = new URL(baseUrl + context.url.pathname)

  try {
    context.verification = await verify(context.request.method, path.pathname, context.request.headers.raw(), {
      fetcher: fetch
    })
  } catch (e) {
    return {
      status: 401,
      body: {
        ok: false,
        message: 'Access denied, invalid signed-fetch request'
      }
    }
  }

  if (!validateMetadata(context.verification!.authMetadata)) {
    throw new InvalidRequestError('Access denied, invalid metadata')
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  if (!context.params.roomId.startsWith(roomPrefix)) {
    throw new InvalidRequestError('Invalid room id requested.')
  }

  const worldName = context.params.roomId.substring(roomPrefix.length)

  if (!(await storage.exist('name-' + worldName))) {
    throw new NotFoundError(`World "${worldName}" does not exist.`)
  }

  const identity = context.verification!.auth
  const hasPermission = await allowedByAcl(context.components, worldName, identity)

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
      token: token.toJwt()
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
