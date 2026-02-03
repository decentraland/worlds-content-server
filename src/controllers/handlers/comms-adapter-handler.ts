import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { InvalidRequestError, NotAuthorizedError, NotFoundError } from '@dcl/http-commons'

type CommsMetadata = {
  secret?: string
}

export async function commsAdapterHandler(
  context: HandlerContextWithPath<
    'access' | 'commsAdapter' | 'config' | 'namePermissionChecker' | 'worlds',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { access, commsAdapter, config, namePermissionChecker, worlds }
  } = context

  const authMetadata = context.verification!.authMetadata
  if (!validateMetadata(authMetadata)) {
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
  const [hasPermission, hasAccess] = await Promise.all([
    namePermissionChecker.checkPermission(identity, worldName),
    access.checkAccess(worldName, identity, authMetadata.secret)
  ])

  if (!hasPermission || !hasAccess) {
    throw new NotAuthorizedError(`You are not allowed to access world "${worldName}".`)
  }

  return {
    status: 200,
    body: {
      fixedAdapter: await commsAdapter.getWorldRoomConnectionString(identity, worldName)
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
