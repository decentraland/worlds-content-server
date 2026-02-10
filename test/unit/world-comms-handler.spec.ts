import { worldCommsHandler } from '../../src/controllers/handlers/world-comms-handler'
import { ICommsComponent } from '../../src/logic/comms/types'
import {
  InvalidAccessError,
  InvalidWorldError,
  SceneNotFoundError,
  WorldAtCapacityError
} from '../../src/logic/comms/errors'
import { HandlerContextWithPath } from '../../src/types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { IAccessComponent, AccessType } from '../../src/logic/access'
import { IRateLimiterComponent } from '../../src/logic/rate-limiter'

type CommsMetadata = {
  secret?: string
}

type HandlerContext = HandlerContextWithPath<
  'access' | 'comms' | 'rateLimiter',
  '/worlds/:worldName/comms' | '/worlds/:worldName/scenes/:sceneId/comms'
> &
  DecentralandSignatureContext<CommsMetadata>

describe('worldCommsHandler', () => {
  let comms: jest.Mocked<ICommsComponent>
  let access: jest.Mocked<Pick<IAccessComponent, 'getAccessForWorld'>>
  let rateLimiter: jest.Mocked<IRateLimiterComponent>
  let context: HandlerContext

  beforeEach(() => {
    comms = {
      getWorldRoomConnectionString: jest.fn(),
      getWorldSceneRoomConnectionString: jest.fn()
    } as jest.Mocked<ICommsComponent>

    access = {
      getAccessForWorld: jest.fn().mockResolvedValue({ type: AccessType.Unrestricted })
    }

    rateLimiter = {
      recordFailedAttempt: jest.fn().mockResolvedValue({ rateLimited: false }),
      clearAttempts: jest.fn().mockResolvedValue(undefined)
    }
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the request has no auth metadata', () => {
    beforeEach(() => {
      context = {
        components: { access, comms, rateLimiter },
        params: { worldName: 'test-world' },
        request: { headers: new Map() },
        verification: {
          auth: '0x1234567890abcdef',
          authMetadata: undefined
        }
      } as unknown as HandlerContext
    })

    it('should throw InvalidRequestError', async () => {
      await expect(worldCommsHandler(context)).rejects.toThrow('Access denied, invalid metadata')
    })
  })

  describe('when the request is for a world comms', () => {
    const worldName = 'test-world'
    const identity = '0x1234567890abcdef'
    const connectionString = 'livekit:wss://host?access_token=abc123'

    beforeEach(() => {
      context = {
        components: { access, comms, rateLimiter },
        params: { worldName },
        request: { headers: new Map() },
        verification: {
          auth: identity,
          authMetadata: {}
        }
      } as unknown as HandlerContext
    })

    describe('and the comms component returns a connection string', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should return 200 with the fixedAdapter', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ fixedAdapter: connectionString })
      })

      it('should call getWorldRoomConnectionString with correct parameters', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).toHaveBeenCalledWith(identity, worldName, { secret: undefined })
      })
    })

    describe('and the request includes a secret', () => {
      beforeEach(() => {
        context = {
          components: { access, comms, rateLimiter },
          params: { worldName },
          request: { headers: new Map() },
          verification: {
            auth: identity,
            authMetadata: { secret: 'my-secret' }
          }
        } as unknown as HandlerContext

        comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should pass the secret to getWorldRoomConnectionString', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).toHaveBeenCalledWith(identity, worldName, { secret: 'my-secret' })
      })
    })

    describe('and the comms component throws InvalidAccessError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should return 403 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(403)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws InvalidWorldError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidWorldError(worldName))
      })

      it('should return 404 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws WorldAtCapacityError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new WorldAtCapacityError(worldName))
      })

      it('should return 503 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(503)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws an unexpected error', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new Error('Unexpected error'))
      })

      it('should re-throw the error', async () => {
        await expect(worldCommsHandler(context)).rejects.toThrow('Unexpected error')
      })
    })
  })

  describe('when the request is for a scene comms', () => {
    const worldName = 'test-world'
    const sceneId = 'scene-123'
    const identity = '0x1234567890abcdef'
    const connectionString = 'livekit:wss://host?access_token=abc123'

    beforeEach(() => {
      context = {
        components: { access, comms, rateLimiter },
        params: { worldName, sceneId },
        request: { headers: new Map() },
        verification: {
          auth: identity,
          authMetadata: {}
        }
      } as unknown as HandlerContext
    })

    describe('and the comms component returns a connection string', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should return 200 with the fixedAdapter', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ fixedAdapter: connectionString })
      })

      it('should call getSceneRoomConnectionString with correct parameters', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldSceneRoomConnectionString).toHaveBeenCalledWith(identity, worldName, sceneId, {
          secret: undefined
        })
      })

      it('should not call getWorldRoomConnectionString', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).not.toHaveBeenCalled()
      })
    })

    describe('and the request includes a secret', () => {
      beforeEach(() => {
        context = {
          components: { access, comms, rateLimiter },
          params: { worldName, sceneId },
          request: { headers: new Map() },
          verification: {
            auth: identity,
            authMetadata: { secret: 'my-secret' }
          }
        } as unknown as HandlerContext

        comms.getWorldSceneRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should pass the secret to getSceneRoomConnectionString', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldSceneRoomConnectionString).toHaveBeenCalledWith(identity, worldName, sceneId, {
          secret: 'my-secret'
        })
      })
    })

    describe('and the comms component throws InvalidAccessError', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should return 403 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(403)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws InvalidWorldError', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new InvalidWorldError(worldName))
      })

      it('should return 404 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws SceneNotFoundError', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new SceneNotFoundError(worldName, sceneId))
      })

      it('should return 404 with the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(sceneId) })
      })
    })

    describe('and the comms component throws an unexpected error', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new Error('Unexpected error'))
      })

      it('should re-throw the error', async () => {
        await expect(worldCommsHandler(context)).rejects.toThrow('Unexpected error')
      })
    })
  })

  describe('when the world has shared-secret access', () => {
    const worldName = 'secret-world'
    const identity = '0x1234567890abcdef'
    const connectionString = 'livekit:wss://host?access_token=abc123'
    const clientIp = '1.2.3.4'

    beforeEach(() => {
      access.getAccessForWorld = jest.fn().mockResolvedValue({
        type: AccessType.SharedSecret,
        secret: '$2b$10$hashedSecret'
      })

      context = {
        components: { access, comms, rateLimiter },
        params: { worldName },
        request: {
          headers: new Map([['cf-connecting-ip', clientIp]])
        },
        verification: {
          auth: identity,
          authMetadata: { secret: 'my-secret' }
        }
      } as unknown as HandlerContext
    })

    describe('and the request succeeds', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should clear attempts on successful connection', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(rateLimiter.clearAttempts).toHaveBeenCalledWith(worldName, clientIp)
      })
    })

    describe('and the secret is wrong (InvalidAccessError)', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should return 403 and record the failed attempt', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(403)
        expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, clientIp)
      })
    })

    describe('and the rate limiter reports the subject is rate-limited', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
        rateLimiter.recordFailedAttempt.mockResolvedValue({ rateLimited: true })
      })

      it('should return 429 with Retry-After header', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(429)
        expect(response.headers).toEqual(expect.objectContaining({ 'Retry-After': '60' }))
        expect(response.body).toEqual({ error: 'Too many shared-secret attempts. Try again later.' })
      })
    })

    describe('and no cf-connecting-ip header is present', () => {
      beforeEach(() => {
        context = {
          components: { access, comms, rateLimiter },
          params: { worldName },
          request: {
            headers: new Map([['x-forwarded-for', '5.6.7.8, 9.10.11.12']])
          },
          verification: {
            auth: identity,
            authMetadata: { secret: 'my-secret' }
          }
        } as unknown as HandlerContext

        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should use the first IP from x-forwarded-for as the subject', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, '5.6.7.8')
      })
    })

    describe('and no IP headers are present', () => {
      beforeEach(() => {
        context = {
          components: { access, comms, rateLimiter },
          params: { worldName },
          request: {
            headers: new Map()
          },
          verification: {
            auth: identity,
            authMetadata: { secret: 'my-secret' }
          }
        } as unknown as HandlerContext

        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should fallback to the wallet identity as the subject', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, identity)
      })
    })
  })

  describe('when the world has non-shared-secret access', () => {
    const worldName = 'open-world'
    const identity = '0x1234567890abcdef'
    const connectionString = 'livekit:wss://host?access_token=abc123'

    beforeEach(() => {
      access.getAccessForWorld = jest.fn().mockResolvedValue({ type: AccessType.Unrestricted })

      context = {
        components: { access, comms, rateLimiter },
        params: { worldName },
        request: { headers: new Map() },
        verification: {
          auth: identity,
          authMetadata: {}
        }
      } as unknown as HandlerContext

      comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
    })

    it('should not interact with the rate limiter at all', async () => {
      const response = await worldCommsHandler(context)

      expect(response.status).toBe(200)
      expect(rateLimiter.recordFailedAttempt).not.toHaveBeenCalled()
      expect(rateLimiter.clearAttempts).not.toHaveBeenCalled()
    })
  })
})
