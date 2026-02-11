import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { InvalidRequestError } from '@dcl/http-commons'
import { InvalidAccessError, InvalidWorldError, SceneNotFoundError, WorldAtCapacityError } from '../../logic/comms'
import { AccessType } from '../../logic/access'
import { RATE_LIMIT_WINDOW_SECONDS, RateLimitedError } from '../../logic/rate-limiter'

type CommsMetadata = {
  secret?: string
}

function extractClientIp(request: IHttpServerComponent.IRequest): string | undefined {
  return request.headers.get('cf-connecting-ip') ?? undefined
}

function extractSubject(context: HandlerContext): string {
  return extractClientIp(context.request) || context.verification!.auth
}

type HandlerContext = HandlerContextWithPath<
  'access' | 'comms' | 'rateLimiter',
  '/worlds/:worldName/comms' | '/worlds/:worldName/scenes/:sceneId/comms'
> &
  DecentralandSignatureContext<CommsMetadata>

export async function worldCommsHandler(context: HandlerContext): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { access, comms, rateLimiter }
  } = context

  const { worldName } = context.params
  const sceneId = 'sceneId' in context.params ? context.params.sceneId : undefined

  const authMetadata = context.verification?.authMetadata
  if (!authMetadata) {
    throw new InvalidRequestError('Access denied, invalid metadata')
  }

  const identity = context.verification!.auth
  const accessOptions = { secret: authMetadata.secret }

  const accessSetting = await access.getAccessForWorld(worldName)
  const isSharedSecret = accessSetting.type === AccessType.SharedSecret

  try {
    if (isSharedSecret) {
      const rateLimited = await rateLimiter.isRateLimited(worldName, extractSubject(context))
      if (rateLimited) {
        throw new RateLimitedError(worldName)
      }
    }

    let fixedAdapter: string
    if (sceneId) {
      fixedAdapter = await comms.getWorldSceneRoomConnectionString(identity, worldName, sceneId, accessOptions)
    } else {
      fixedAdapter = await comms.getWorldRoomConnectionString(identity, worldName, accessOptions)
    }

    if (isSharedSecret) {
      await rateLimiter.clearAttempts(worldName, extractSubject(context))
    }

    return {
      status: 200,
      body: {
        fixedAdapter
      }
    }
  } catch (error) {
    if (error instanceof InvalidAccessError && isSharedSecret) {
      const { rateLimited } = await rateLimiter.recordFailedAttempt(worldName, extractSubject(context))
      if (rateLimited) {
        return {
          status: 429,
          headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
          body: { error: 'Too many shared-secret attempts. Try again later.' }
        }
      }
      return {
        status: 403,
        body: { error: error.message }
      }
    } else if (error instanceof InvalidAccessError) {
      return {
        status: 403,
        body: { error: error.message }
      }
    } else if (error instanceof InvalidWorldError || error instanceof SceneNotFoundError) {
      return {
        status: 404,
        body: { error: error.message }
      }
    } else if (error instanceof WorldAtCapacityError) {
      return {
        status: 503,
        body: { error: error.message }
      }
    } else if (error instanceof RateLimitedError) {
      return {
        status: 429,
        headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS) },
        body: { error: 'Too many shared-secret attempts. Try again later.' }
      }
    }

    throw error
  }
}
