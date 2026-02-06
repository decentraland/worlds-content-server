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
                  roomName: 'world-prd-sample.dcl.eth',
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
            worldName: 'sample.dcl.eth'
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
                { roomName: 'world-prd-sample.dcl.eth', count: 2 },
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

      expect(await commsAdapter.getWorldRoomParticipantCount('sample.dcl.eth')).toBe(2)
      expect(await commsAdapter.getWorldRoomParticipantCount('an-empty-world.dcl.eth')).toBe(0)
      expect(await commsAdapter.getWorldRoomParticipantCount('nonexistent.dcl.eth')).toBe(0)
    })

    it('returns sum of scene room participant counts for a world', async () => {
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
              users: 10,
              rooms: 3,
              details: [
                { roomName: 'scene-prd-sample.dcl.eth-scene1', count: 5 },
                { roomName: 'scene-prd-sample.dcl.eth-scene2', count: 3 },
                { roomName: 'scene-prd-another-world.dcl.eth-scene1', count: 2 }
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

      expect(await commsAdapter.getWorldSceneRoomsParticipantCount('sample.dcl.eth')).toBe(8)
      expect(await commsAdapter.getWorldSceneRoomsParticipantCount('another-world.dcl.eth')).toBe(2)
      expect(await commsAdapter.getWorldSceneRoomsParticipantCount('nonexistent.dcl.eth')).toBe(0)
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

      const listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue([
        { name: 'world-prd-sample.dcl.eth', numParticipants: 3 },
        { name: 'world-prd-another-world.dcl.eth', numParticipants: 1 }
      ])
      const livekitClient = createMockLivekitClient({
        listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
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
            worldName: 'prd-sample.dcl.eth'
          },
          {
            users: 1,
            worldName: 'prd-another-world.dcl.eth'
          }
        ]
      })
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledTimes(1)
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
    })

    it('aggregates status from many world rooms returned by listRoomsWithParticipantCounts', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const roomsWithCounts = Array.from({ length: 12 }, (_, i) => ({
        name: `world-room-${i + 1}`,
        numParticipants: i + 1
      }))
      const listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue(roomsWithCounts)
      const livekitClient = createMockLivekitClient({
        listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
      })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      const adapter = await commsAdapter.status()

      const expectedUsers = roomsWithCounts.reduce((s, r) => s + r.numParticipants, 0)
      expect(adapter.rooms).toBe(12)
      expect(adapter.users).toBe(expectedUsers)
      expect(adapter.details).toHaveLength(12)
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
    })

    it('returns empty details when listRoomsWithParticipantCounts fails', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const listRoomsWithParticipantCountsMock = jest.fn().mockRejectedValue(new Error('Chunk request failed'))
      const livekitClient = createMockLivekitClient({
        listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
      })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      const adapter = await commsAdapter.status()

      expect(adapter.adapterType).toBe('livekit')
      expect(adapter.rooms).toBe(0)
      expect(adapter.users).toBe(0)
      expect(adapter.details).toHaveLength(0)
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
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
        listRoomsWithParticipantCounts: jest.fn().mockRejectedValue(new Error('Failed to fetch comms status'))
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

    it('returns sum of scene room participant counts for a world', async () => {
      const config: IConfigComponent = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'scene-',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'myApiKey',
        LIVEKIT_API_SECRET: 'myApiSecret'
      })
      const logs = await createLogComponent({ config })

      const listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue([
        { name: 'scene-sample.dcl.eth-scene1', numParticipants: 4 },
        { name: 'scene-sample.dcl.eth-scene2', numParticipants: 3 }
      ])
      const livekitClient = createMockLivekitClient({
        listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
      })

      const fetch: IFetchComponent = {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      }
      const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })

      expect(await commsAdapter.getWorldSceneRoomsParticipantCount('sample.dcl.eth')).toBe(7)
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledTimes(1)
      expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({
        namePrefix: 'scene-sample.dcl.eth-'
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
