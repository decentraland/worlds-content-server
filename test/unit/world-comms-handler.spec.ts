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

type CommsMetadata = {
  secret?: string
}

type HandlerContext = HandlerContextWithPath<
  'comms',
  '/worlds/:worldName/comms' | '/worlds/:worldName/scenes/:sceneId/comms'
> &
  DecentralandSignatureContext<CommsMetadata>

describe('worldCommsHandler', () => {
  let comms: jest.Mocked<ICommsComponent>
  let context: HandlerContext

  beforeEach(() => {
    comms = {
      getWorldRoomConnectionString: jest.fn(),
      getWorldSceneRoomConnectionString: jest.fn()
    } as jest.Mocked<ICommsComponent>
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the request has no auth metadata', () => {
    beforeEach(() => {
      context = {
        components: { comms },
        params: { worldName: 'test-world' },
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
        components: { comms },
        params: { worldName },
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
          components: { comms },
          params: { worldName },
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
        components: { comms },
        params: { worldName, sceneId },
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
          components: { comms },
          params: { worldName, sceneId },
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
})
