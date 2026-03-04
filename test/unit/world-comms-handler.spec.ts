import { worldCommsHandler } from '../../src/controllers/handlers/world-comms-handler'
import { ICommsComponent } from '../../src/logic/comms/types'
import {
  InvalidAccessError,
  InvalidWorldError,
  SceneNotFoundError,
  WorldAtCapacityError,
  UserDenylistedError,
  UserBannedFromWorldError
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
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the request is for a world comms', () => {
    let worldName: string
    let identity: string
    let comms: jest.Mocked<ICommsComponent>
    let access: jest.Mocked<Pick<IAccessComponent, 'getAccessForWorld'>>
    let rateLimiter: jest.Mocked<IRateLimiterComponent>
    let context: HandlerContext

    beforeEach(() => {
      worldName = 'test-world'
      identity = '0x1234567890abcdef'

      comms = {
        getWorldRoomConnectionString: jest.fn(),
        getWorldSceneRoomConnectionString: jest.fn()
      } as jest.Mocked<ICommsComponent>

      access = {
        getAccessForWorld: jest.fn().mockResolvedValueOnce({ type: AccessType.Unrestricted })
      }

      rateLimiter = {
        isRateLimited: jest.fn().mockResolvedValueOnce(false),
        recordFailedAttempt: jest.fn().mockResolvedValueOnce({ rateLimited: false }),
        clearAttempts: jest.fn().mockResolvedValueOnce(undefined)
      }

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
      let connectionString: string

      beforeEach(() => {
        connectionString = 'livekit:wss://host?access_token=abc123'
        comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should respond with 200 and the fixedAdapter', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ fixedAdapter: connectionString })
      })

      it('should call getWorldRoomConnectionString with the identity, world name, and access options', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).toHaveBeenCalledWith(identity, worldName, { secret: undefined })
      })
    })

    describe('and the request includes a secret', () => {
      let connectionString: string

      beforeEach(() => {
        connectionString = 'livekit:wss://host?access_token=abc123'

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

      it('should pass the secret in the access options', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).toHaveBeenCalledWith(identity, worldName, { secret: 'my-secret' })
      })
    })

    describe('and the comms component throws InvalidAccessError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should respond with 401 and the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws InvalidWorldError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidWorldError(worldName))
      })

      it('should respond with 404 and the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws WorldAtCapacityError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new WorldAtCapacityError(worldName))
      })

      it('should respond with 503 and the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(503)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws UserDenylistedError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new UserDenylistedError())
      })

      it('should respond with 401 and the deny-listed message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: 'Access denied, deny-listed wallet.' })
      })
    })

    describe('and the comms component throws UserBannedFromWorldError', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new UserBannedFromWorldError(worldName))
      })

      it('should respond with 401 and the banned message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: `You are banned from world "${worldName}".` })
      })
    })

    describe('and the comms component throws an unexpected error', () => {
      beforeEach(() => {
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new Error('Unexpected error'))
      })

      it('should propagate the error', async () => {
        await expect(worldCommsHandler(context)).rejects.toThrow('Unexpected error')
      })
    })
  })

  describe('when the request is for a scene comms', () => {
    let worldName: string
    let sceneId: string
    let identity: string
    let comms: jest.Mocked<ICommsComponent>
    let access: jest.Mocked<Pick<IAccessComponent, 'getAccessForWorld'>>
    let rateLimiter: jest.Mocked<IRateLimiterComponent>
    let context: HandlerContext

    beforeEach(() => {
      worldName = 'test-world'
      sceneId = 'scene-123'
      identity = '0x1234567890abcdef'

      comms = {
        getWorldRoomConnectionString: jest.fn(),
        getWorldSceneRoomConnectionString: jest.fn()
      } as jest.Mocked<ICommsComponent>

      access = {
        getAccessForWorld: jest.fn().mockResolvedValueOnce({ type: AccessType.Unrestricted })
      }

      rateLimiter = {
        isRateLimited: jest.fn().mockResolvedValueOnce(false),
        recordFailedAttempt: jest.fn().mockResolvedValueOnce({ rateLimited: false }),
        clearAttempts: jest.fn().mockResolvedValueOnce(undefined)
      }

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
      let connectionString: string

      beforeEach(() => {
        connectionString = 'livekit:wss://host?access_token=abc123'
        comms.getWorldSceneRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should respond with 200 and the fixedAdapter', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ fixedAdapter: connectionString })
      })

      it('should call getWorldSceneRoomConnectionString with the identity, world name, scene id, and access options', async () => {
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
      let connectionString: string

      beforeEach(() => {
        connectionString = 'livekit:wss://host?access_token=abc123'

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

      it('should pass the secret in the access options', async () => {
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

      it('should respond with 401 and the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws InvalidWorldError', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new InvalidWorldError(worldName))
      })

      it('should respond with 404 and the error message', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
      })
    })

    describe('and the comms component throws SceneNotFoundError', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new SceneNotFoundError(worldName, sceneId))
      })

      it('should respond with 404 and the error message containing the scene id', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: expect.stringContaining(sceneId) })
      })
    })

    describe('and the comms component throws an unexpected error', () => {
      beforeEach(() => {
        comms.getWorldSceneRoomConnectionString.mockRejectedValueOnce(new Error('Unexpected error'))
      })

      it('should propagate the error', async () => {
        await expect(worldCommsHandler(context)).rejects.toThrow('Unexpected error')
      })
    })
  })

  describe('when the world has shared-secret access', () => {
    let worldName: string
    let identity: string
    let clientIp: string
    let comms: jest.Mocked<ICommsComponent>
    let access: jest.Mocked<Pick<IAccessComponent, 'getAccessForWorld'>>
    let rateLimiter: jest.Mocked<IRateLimiterComponent>
    let context: HandlerContext

    beforeEach(() => {
      worldName = 'secret-world'
      identity = '0x1234567890abcdef'
      clientIp = '1.2.3.4'

      comms = {
        getWorldRoomConnectionString: jest.fn(),
        getWorldSceneRoomConnectionString: jest.fn()
      } as jest.Mocked<ICommsComponent>

      access = {
        getAccessForWorld: jest.fn().mockResolvedValueOnce({
          type: AccessType.SharedSecret,
          secret: '$2b$10$hashedSecret'
        })
      }

      rateLimiter = {
        isRateLimited: jest.fn(),
        recordFailedAttempt: jest.fn(),
        clearAttempts: jest.fn()
      }

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
      let connectionString: string

      beforeEach(() => {
        connectionString = 'livekit:wss://host?access_token=abc123'
        rateLimiter.isRateLimited.mockResolvedValueOnce(false)
        comms.getWorldRoomConnectionString.mockResolvedValueOnce(connectionString)
      })

      it('should respond with 200 and the fixedAdapter', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ fixedAdapter: connectionString })
      })

      it('should check rate limit using the client IP', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.isRateLimited).toHaveBeenCalledWith(worldName, clientIp)
      })

      it('should clear rate limit attempts on success', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.clearAttempts).toHaveBeenCalledWith(worldName, clientIp)
      })
    })

    describe('and the secret is wrong', () => {
      beforeEach(() => {
        rateLimiter.isRateLimited.mockResolvedValueOnce(false)
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      describe('and the failed attempt does not cross the rate limit threshold', () => {
        beforeEach(() => {
          rateLimiter.recordFailedAttempt.mockResolvedValueOnce({ rateLimited: false })
        })

        it('should respond with 403 and the error message', async () => {
          const response = await worldCommsHandler(context)

          expect(response.status).toBe(403)
          expect(response.body).toEqual({ error: expect.stringContaining(worldName) })
        })

        it('should record the failed attempt using the client IP', async () => {
          await worldCommsHandler(context)

          expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, clientIp)
        })
      })

      describe('and the failed attempt crosses the rate limit threshold', () => {
        beforeEach(() => {
          rateLimiter.recordFailedAttempt.mockResolvedValueOnce({ rateLimited: true })
        })

        it('should respond with 429 and a Retry-After header', async () => {
          const response = await worldCommsHandler(context)

          expect(response.status).toBe(429)
          expect(response.headers).toEqual(expect.objectContaining({ 'Retry-After': '60' }))
          expect(response.body).toEqual({ error: 'Too many shared-secret attempts. Try again later.' })
        })

        it('should record the failed attempt using the client IP', async () => {
          await worldCommsHandler(context)

          expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, clientIp)
        })
      })
    })

    describe('and the subject is already rate-limited', () => {
      beforeEach(() => {
        rateLimiter.isRateLimited.mockResolvedValueOnce(true)
      })

      it('should respond with 429 and a Retry-After header', async () => {
        const response = await worldCommsHandler(context)

        expect(response.status).toBe(429)
        expect(response.headers).toEqual(expect.objectContaining({ 'Retry-After': '60' }))
        expect(response.body).toEqual({ error: 'Too many shared-secret attempts. Try again later.' })
      })

      it('should not call the comms component', async () => {
        await worldCommsHandler(context)

        expect(comms.getWorldRoomConnectionString).not.toHaveBeenCalled()
      })

      it('should not record an additional failed attempt', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.recordFailedAttempt).not.toHaveBeenCalled()
      })
    })

    describe('and only x-forwarded-for is present without cf-connecting-ip', () => {
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

        rateLimiter.isRateLimited.mockResolvedValueOnce(false)
        rateLimiter.recordFailedAttempt.mockResolvedValueOnce({ rateLimited: false })
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should use the wallet identity as the rate limit subject', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.isRateLimited).toHaveBeenCalledWith(worldName, identity)
        expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, identity)
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

        rateLimiter.isRateLimited.mockResolvedValueOnce(false)
        rateLimiter.recordFailedAttempt.mockResolvedValueOnce({ rateLimited: false })
        comms.getWorldRoomConnectionString.mockRejectedValueOnce(new InvalidAccessError(worldName))
      })

      it('should fall back to the wallet identity as the rate limit subject', async () => {
        await worldCommsHandler(context)

        expect(rateLimiter.recordFailedAttempt).toHaveBeenCalledWith(worldName, identity)
      })
    })
  })

  describe('when the world has non-shared-secret access', () => {
    let worldName: string
    let identity: string
    let comms: jest.Mocked<ICommsComponent>
    let access: jest.Mocked<Pick<IAccessComponent, 'getAccessForWorld'>>
    let rateLimiter: jest.Mocked<IRateLimiterComponent>
    let context: HandlerContext

    beforeEach(() => {
      worldName = 'open-world'
      identity = '0x1234567890abcdef'

      comms = {
        getWorldRoomConnectionString: jest.fn(),
        getWorldSceneRoomConnectionString: jest.fn()
      } as jest.Mocked<ICommsComponent>

      access = {
        getAccessForWorld: jest.fn().mockResolvedValueOnce({ type: AccessType.Unrestricted })
      }

      rateLimiter = {
        isRateLimited: jest.fn(),
        recordFailedAttempt: jest.fn(),
        clearAttempts: jest.fn()
      }

      context = {
        components: { access, comms, rateLimiter },
        params: { worldName },
        request: { headers: new Map() },
        verification: {
          auth: identity,
          authMetadata: {}
        }
      } as unknown as HandlerContext

      comms.getWorldRoomConnectionString.mockResolvedValueOnce('livekit:wss://host?access_token=abc123')
    })

    it('should not interact with the rate limiter', async () => {
      await worldCommsHandler(context)

      expect(rateLimiter.isRateLimited).not.toHaveBeenCalled()
      expect(rateLimiter.recordFailedAttempt).not.toHaveBeenCalled()
      expect(rateLimiter.clearAttempts).not.toHaveBeenCalled()
    })
  })
})
