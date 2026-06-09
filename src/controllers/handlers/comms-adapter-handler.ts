import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { InvalidRequestError, NotAuthorizedError, NotFoundError } from '@dcl/http-commons'
import { AccessType } from '../../logic/access'
import { RATE_LIMIT_WINDOW_SECONDS } from '../../logic/rate-limiter'
import { extractCommsRateLimitSubject } from './comms-rate-limit-subject'

type CommsMetadata = {
  secret?: string
}

export async function commsAdapterHandler(
  context: HandlerContextWithPath<
    'access' | 'commsAdapter' | 'config' | 'namePermissionChecker' | 'rateLimiter' | 'worlds',
    '/get-comms-adapter/:roomId'
  > &
    DecentralandSignatureContext<CommsMetadata>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { access, commsAdapter, config, namePermissionChecker, rateLimiter, worlds }
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
  const subject = extractCommsRateLimitSubject(context.request, identity)
  const accessSetting = await access.getAccessForWorld(worldName)
  const isSharedSecret = accessSetting.type === AccessType.SharedSecret

  if (isSharedSecret && (await rateLimiter.isRateLimited(worldName, subject))) {
    return {
      status: 429,
      headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
      body: { error: 'Too many shared-secret attempts. Try again later.' }
    }
  }

  const [hasPermission, hasAccess] = await Promise.all([
    namePermissionChecker.checkPermission(identity, worldName),
    access.checkAccess(worldName, identity, authMetadata.secret)
  ])

  if (!hasPermission && !hasAccess) {
    if (isSharedSecret) {
      const { rateLimited } = await rateLimiter.recordFailedAttempt(worldName, subject)
      if (rateLimited) {
        return {
          status: 429,
          headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
          body: { error: 'Too many shared-secret attempts. Try again later.' }
        }
      }
    }
    throw new NotAuthorizedError(`You are not allowed to access world "${worldName}".`)
  }

  if (isSharedSecret) {
    await rateLimiter.clearAttempts(worldName, subject)
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
