import { HandlerContextWithPath, InvalidRequestError, NotFoundError } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { verify, DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'

export async function commsAdapterHandler(
  context: HandlerContextWithPath<
    'commsAdapter' | 'fetch' | 'config' | 'nameDenyListChecker' | 'storage',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { commsAdapter, config, fetch, nameDenyListChecker, storage }
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

  if (!(await storage.exist('name-' + worldName))) {
    throw new NotFoundError(`World "${worldName}" does not exist.`)
  }

  return {
    status: 200,
    body: {
      fixedAdapter: await commsAdapter.connectionString(context.verification!.auth, context.params.roomId)
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
