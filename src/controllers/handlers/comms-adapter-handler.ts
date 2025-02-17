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
    'commsAdapter' | 'config' | 'nameDenyListChecker' | 'namePermissionChecker' | 'worldsManager',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { commsAdapter, config, nameDenyListChecker, namePermissionChecker, worldsManager }
  } = context

  const authMetadata = context.verification!.authMetadata
  async function fetchDenyList(): Promise<Set<string>> {
    try {
      const response = await fetch('https://config.decentraland.org/denylist.json')
      if (!response.ok) {
        throw new Error(`Failed to fetch deny list, status: ${response.status}`)
      }
      const data = await response.json()
      if (data.users && Array.isArray(data.users)) {
        return new Set(data.users.map((user: { wallet: string }) => user.wallet.toLocaleLowerCase()))
      } else {
        logger.warn('Deny list is missing "users" field or it is not an array.')
        return new Set()
      }
    } catch (error) {
      logger.error(`Error fetching deny list: ${(error as Error).message}`)
      return new Set()
    }
  }

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
  const denyList = await fetchDenyList()
  if (denyList.has(identity)) {
    logger.warn(`Rejected connection from deny-listed wallet: ${identity}`)
    throw new UnauthorizedError('Access denied, deny-listed wallet')
  }
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
