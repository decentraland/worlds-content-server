import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { assertNotBlockedOrWithinInGracePeriod } from '../../logic/blocked'
import { InvalidRequestError, NotAuthorizedError, NotFoundError } from '@dcl/platform-server-commons'

type CommsMetadata = {
  secret?: string
}

export async function commsAdapterHandler(
  context: HandlerContextWithPath<
    'commsAdapter' | 'config' | 'nameDenyListChecker' | 'namePermissionChecker' | 'worldsManager' | 'logs',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { commsAdapter, config, nameDenyListChecker, namePermissionChecker, worldsManager, logs }
  } = context

  const logger = logs.getLogger('comms')

  const params = new URLSearchParams(context.url.search)
  const ea = params.get('ea')

  const authMetadata = context.verification!.authMetadata
  if (!validateMetadata(authMetadata)) {
    throw new InvalidRequestError('Access denied, invalid metadata')
  }

  let roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')

  if (!context.params.roomId.startsWith(roomPrefix)) {
    throw new InvalidRequestError('Invalid room id requested.')
  }

  //PATCH: if ?ea=true, we need to add the scene room prefix to connecto the scene room in the Explorer Alpha
  //This is a temp PATCH to test cast with the EA
  if (ea === 'true') {
    roomPrefix += '-scene-room-'
    logger.info('request for explorer alpha scene room, prefix: ' + roomPrefix)
  }

  const worldName = context.params.roomId.substring(roomPrefix.length)
  logger.info('worldName: ' + worldName)

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

  const fixedAdapter = await commsAdapter.connectionString(identity, context.params.roomId)
  logger.info('fixedAdapter: ' + fixedAdapter)
  return {
    status: 200,
    body: {
      fixedAdapter
    }
  }
}

function validateMetadata(metadata: Record<string, any>): boolean {
  return metadata.signer === 'dcl:explorer' && metadata.intent === 'dcl:explorer:comms-handshake'
}
