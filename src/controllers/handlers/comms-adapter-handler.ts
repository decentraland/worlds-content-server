import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { verify, DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { assertNotBlockedOrWithinInGracePeriod } from '../../logic/blocked'
import { InvalidRequestError, NotAuthorizedError, NotFoundError } from '@dcl/platform-server-commons'

type CommsMetadata = {
  secret?: string
}

export async function commsAdapterHandler(
  context: HandlerContextWithPath<
    'commsAdapter' | 'fetch' | 'config' | 'nameDenyListChecker' | 'namePermissionChecker' | 'worldsManager',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { commsAdapter, config, fetch, nameDenyListChecker, namePermissionChecker, worldsManager }
  } = context

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

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

  const authMetadata = context.verification!.authMetadata
  if (!validateMetadata(authMetadata)) {
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
    // TODO See if we can avoid the first check
    (await namePermissionChecker.checkPermission(identity, worldName)) ||
    (await permissionChecker.checkPermission('access', identity, authMetadata.secret))
  if (!hasPermission) {
    throw new NotAuthorizedError(`You are not allowed to access world "${worldName}".`)
  }

  return {
    status: 200,
    body: {
      fixedAdapter: await commsAdapter.connectionString(identity, context.params.roomId)
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
