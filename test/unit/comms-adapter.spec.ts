import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createCommsAdapterComponent } from '../../src/adapters/comms-adapter'
import { createLogComponent } from '@well-known-components/logger'
import { IFetchComponent } from '@well-known-components/interfaces'
import { Request, Response } from 'node-fetch'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'

describe('comms-adapter', function () {
  describe('ws-room', function () {
    it('resolves connection string when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room',
        COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
        COMMS_ROOM_PREFIX: 'world-prd-',
        SCENE_ROOM_PREFIX: 'scene-prd-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }

      const commsAdapter = await createCommsAdapterComponent({
        config,
        fetch,
        logs,
        livekitClient: createMockLivekitClient()
      })

      expect(await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')).toBe(
        'ws-room:ws-room-service.decentraland.org/rooms/world-prd-my-room'
      )
    })

    it('resolves status when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room',
        COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
        COMMS_ROOM_PREFIX: 'world-prd-',
        SCENE_ROOM_PREFIX: 'scene-prd-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> =>
          new Response(
            JSON.stringify({
              commitHash: 'unknown',
              users: 2,
              rooms: 1,
              details: [
                {
                  roomName: 'world-prd-mariano.dcl.eth',
                  count: 2
                },
                {
                  roomName: 'world-prd-an-empty-world.dcl.eth',
                  count: 0
                }
              ]
            })
          )
      }

      const commsAdapter = await createCommsAdapterComponent({
        config,
        fetch,
        logs,
        livekitClient: createMockLivekitClient()
      })

      expect(await commsAdapter.status()).toMatchObject({
        rooms: 1,
        users: 2,
        details: [
          {
            users: 2,
            worldName: 'mariano.dcl.eth'
          }
        ]
      })
    })

    it('returns room participant count from cached status', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room',
        COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
        COMMS_ROOM_PREFIX: 'world-prd-',
        SCENE_ROOM_PREFIX: 'scene-prd-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> =>
          new Response(
            JSON.stringify({
              commitHash: 'unknown',
              users: 2,
              rooms: 1,
              details: [
                { roomName: 'world-prd-mariano.dcl.eth', count: 2 },
                { roomName: 'world-prd-an-empty-world.dcl.eth', count: 0 }
              ]
            })
          )
      }

      const commsAdapter = await createCommsAdapterComponent({
        config,
        fetch,
        logs,
        livekitClient: createMockLivekitClient()
      })

      expect(await commsAdapter.getRoomParticipantCount('mariano.dcl.eth')).toBe(2)
      expect(await commsAdapter.getRoomParticipantCount('an-empty-world.dcl.eth')).toBe(0)
      expect(await commsAdapter.getRoomParticipantCount('nonexistent.dcl.eth')).toBe(0)
    })

    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'ws-room',
        COMMS_ROOM_PREFIX: 'world-prd-',
        SCENE_ROOM_PREFIX: 'scene-prd-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }

      await expect(
        createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      ).rejects.toThrow('Configuration: string COMMS_FIXED_ADAPTER is required')
    })
  })

  describe('livekit', function () {
    it('resolves connection string when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }

      const livekitClient = createMockLivekitClient({
        createConnectionToken: jest.fn().mockResolvedValue('livekit:wss://livekit.dcl.org?access_token=token')
      })
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      const adapter = await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')
      expect(adapter).toContain('livekit:wss://livekit.dcl.org?access_token=')
      expect(livekitClient.createConnectionToken).toHaveBeenCalledWith(
        '0xa',
        expect.objectContaining({ room: 'world-my-room' })
      )
    })

    it('resolves status when well configured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const livekitClient = createMockLivekitClient({
        listRooms: jest.fn().mockResolvedValue([
          { name: 'world-prd-mariano.dcl.eth', numParticipants: 3 },
          { name: 'world-prd-another-world.dcl.eth', numParticipants: 1 }
        ])
      })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      const adapter = await commsAdapter.status()
      expect(adapter).toMatchObject({
        rooms: 2,
        users: 4,
        details: [
          {
            users: 3,
            worldName: 'prd-mariano.dcl.eth'
          },
          {
            users: 1,
            worldName: 'prd-another-world.dcl.eth'
          }
        ]
      })
    })

    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }

      await expect(
        createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      ).rejects.toThrow('Configuration: string LIVEKIT_HOST is required')
    })

    it('survives failure to retrieve comms status', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const livekitClient = createMockLivekitClient({
        listRooms: jest.fn().mockRejectedValue(new Error('Failed to fetch comms status'))
      })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      const status = await commsAdapter.status()
      expect(status).toMatchObject({
        adapterType: 'livekit',
        rooms: 0,
        users: 0,
        details: []
      })
    })
  })

  describe('invalid adapter', function () {
    it('refuses to initialize when misconfigured', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'other',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-'
      })
      const logs = await createLogComponent({ config })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }

      await expect(
        createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      ).rejects.toThrow('Invalid comms adapter: other')
    })
  })
})
