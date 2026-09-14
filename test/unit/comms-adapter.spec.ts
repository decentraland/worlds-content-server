import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IFetchComponent } from '@dcl/core-commons'
import { createCommsAdapterComponent, STATUS_CACHE_TTL_MS } from '../../src/adapters/comms-adapter'
import { createLogComponent } from '@well-known-components/logger'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { CommsStatus, ICommsAdapter, LivekitClient } from '../../src/types'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'

describe('comms-adapter', function () {
  describe('ws-room', function () {
    describe('when resolving connection string', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
          COMMS_ADAPTER: 'ws-room',
          COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
          COMMS_ROOM_PREFIX: 'world-prd-',
          SCENE_ROOM_PREFIX: 'scene-prd-'
        })
        const logs = await createLogComponent({ config })
        const fetch: IFetchComponent = {
          fetch: async (_url: Request): Promise<Response> => new Response(undefined)
        }
        commsAdapter = await createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      })

      it('should return the prefixed room URL', async () => {
        expect(await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')).toBe(
          'ws-room:ws-room-service.decentraland.org/rooms/world-prd-my-room'
        )
      })
    })

    // Iteration 2: `commsAdapter.status()` is always Pulse-sourced now (see the `presence` describe
    // below), so the ws-room transport's own status parsing is only observable through the surviving
    // capacity-check exception, `getWorldRoomParticipantCount` — which reads the transport's own
    // cached status, never Pulse.
    describe('when getting room participant count and scene room prefix starts with world room prefix', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
          COMMS_ADAPTER: 'ws-room',
          COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'world-scene-room-'
        })
        const logs = await createLogComponent({ config })
        const fetch: IFetchComponent = {
          fetch: async (_url: Request): Promise<Response> =>
            new Response(
              JSON.stringify({
                commitHash: 'unknown',
                users: 147,
                rooms: 2,
                details: [
                  { roomName: 'world-sheficlub.dcl.eth', count: 71 },
                  {
                    roomName:
                      'world-scene-room-sheficlub.dcl.eth-bafkreieivzadtylq2pug33h2eabvsvkamjtjxk3tqex3wumerjzqeqa7yu',
                    count: 76
                  }
                ]
              })
            )
        }
        commsAdapter = await createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      })

      it('should exclude the scene room from the world room count', async () => {
        expect(await commsAdapter.getWorldRoomParticipantCount('sheficlub.dcl.eth')).toBe(71)
      })
    })

    describe('when getting room participant count from cached status', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
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
        commsAdapter = await createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      })

      it('should return the count for an existing world', async () => {
        expect(await commsAdapter.getWorldRoomParticipantCount('sample.dcl.eth')).toBe(2)
      })

      it('should return 0 for an empty world', async () => {
        expect(await commsAdapter.getWorldRoomParticipantCount('an-empty-world.dcl.eth')).toBe(0)
      })

      it('should return 0 for a nonexistent world', async () => {
        expect(await commsAdapter.getWorldRoomParticipantCount('nonexistent.dcl.eth')).toBe(0)
      })
    })

    describe('when getting scene room participant counts', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
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
        commsAdapter = await createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      })

      it('should return the sum of counts for a world with multiple scenes', async () => {
        expect(await commsAdapter.getWorldSceneRoomsParticipantCount('sample.dcl.eth')).toBe(8)
      })

      it('should return the count for a world with a single scene', async () => {
        expect(await commsAdapter.getWorldSceneRoomsParticipantCount('another-world.dcl.eth')).toBe(2)
      })

      it('should return 0 for a nonexistent world', async () => {
        expect(await commsAdapter.getWorldSceneRoomsParticipantCount('nonexistent.dcl.eth')).toBe(0)
      })
    })

    describe('when removing a participant', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
          COMMS_ADAPTER: 'ws-room',
          COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
          COMMS_ROOM_PREFIX: 'world-prd-',
          SCENE_ROOM_PREFIX: 'scene-prd-'
        })
        const logs = await createLogComponent({ config })
        const fetch: IFetchComponent = {
          fetch: async (_url: Request): Promise<Response> => new Response(undefined)
        }
        commsAdapter = await createCommsAdapterComponent({
          config,
          fetch,
          logs,
          livekitClient: createMockLivekitClient()
        })
      })

      it('should resolve without throwing', async () => {
        await expect(commsAdapter.removeParticipant('world-prd-sample.dcl.eth', '0xuser123')).resolves.toBeUndefined()
      })
    })

    describe('when COMMS_FIXED_ADAPTER is not configured', () => {
      it('should refuse to initialize', async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
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
  })

  describe('livekit', function () {
    describe('when resolving connection string', () => {
      let commsAdapter: ICommsAdapter
      let livekitClient: ReturnType<typeof createMockLivekitClient>

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
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
        livekitClient = createMockLivekitClient({
          createConnectionToken: jest.fn().mockResolvedValue('livekit:wss://livekit.dcl.org?access_token=token')
        })
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
      })

      it('should return a livekit connection string', async () => {
        const result = await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')
        expect(result).toContain('livekit:wss://livekit.dcl.org?access_token=')
      })

      it('should call createConnectionToken with lowercased userId and prefixed room', async () => {
        await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')
        expect(livekitClient.createConnectionToken).toHaveBeenCalledWith(
          '0xa',
          expect.objectContaining({ room: 'world-my-room' })
        )
      })
    })

    // Iteration 2: `commsAdapter.status()` is always Pulse-sourced now (see the `presence` describe
    // below), so the livekit transport's own status parsing is only observable through the surviving
    // capacity-check exception, `getWorldRoomParticipantCount` — which reads the transport's own
    // cached status, never Pulse.
    describe('when getting room participant count from the transport status', () => {
      describe('and rooms have active users', () => {
        let commsAdapter: ICommsAdapter
        let listRoomsWithParticipantCountsMock: jest.Mock

        beforeEach(async () => {
          const config = await createConfigComponent({
            PULSE_URL: 'https://pulse.example.com',
            COMMS_ADAPTER: 'livekit',
            COMMS_ROOM_PREFIX: 'world-',
            SCENE_ROOM_PREFIX: 'scene-',
            LIVEKIT_HOST: 'livekit.dcl.org',
            LIVEKIT_API_KEY: 'myApiKey',
            LIVEKIT_API_SECRET: 'myApiSecret'
          })
          const logs = await createLogComponent({ config })
          listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue([
            { name: 'world-prd-sample.dcl.eth', numParticipants: 3 },
            { name: 'world-prd-another-world.dcl.eth', numParticipants: 1 }
          ])
          const livekitClient = createMockLivekitClient({
            listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
          })
          const fetch: IFetchComponent = {
            fetch: async (_url: Request): Promise<Response> => new Response(undefined)
          }
          commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
        })

        it('should return the count with stripped prefixes', async () => {
          expect(await commsAdapter.getWorldRoomParticipantCount('prd-sample.dcl.eth')).toBe(3)
          expect(await commsAdapter.getWorldRoomParticipantCount('prd-another-world.dcl.eth')).toBe(1)
        })

        it('should call listRoomsWithParticipantCounts with the world room prefix', async () => {
          await commsAdapter.getWorldRoomParticipantCount('prd-sample.dcl.eth')

          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
        })
      })

      describe('and scene room prefix starts with world room prefix', () => {
        let commsAdapter: ICommsAdapter

        beforeEach(async () => {
          const config = await createConfigComponent({
            PULSE_URL: 'https://pulse.example.com',
            COMMS_ADAPTER: 'livekit',
            COMMS_ROOM_PREFIX: 'world-',
            SCENE_ROOM_PREFIX: 'world-scene-room-',
            LIVEKIT_HOST: 'livekit.dcl.org',
            LIVEKIT_API_KEY: 'myApiKey',
            LIVEKIT_API_SECRET: 'myApiSecret'
          })
          const logs = await createLogComponent({ config })
          const livekitClient = createMockLivekitClient({
            listRoomsWithParticipantCounts: jest.fn().mockResolvedValue([
              { name: 'world-sheficlub.dcl.eth', numParticipants: 71 },
              {
                name: 'world-scene-room-sheficlub.dcl.eth-bafkreieivzadtylq2pug33h2eabvsvkamjtjxk3tqex3wumerjzqeqa7yu',
                numParticipants: 76
              }
            ])
          })
          const fetch: IFetchComponent = {
            fetch: async (_url: Request): Promise<Response> => new Response(undefined)
          }
          commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
        })

        it('should exclude the scene room from the world room count', async () => {
          expect(await commsAdapter.getWorldRoomParticipantCount('sheficlub.dcl.eth')).toBe(71)
        })
      })

      describe('and listRoomsWithParticipantCounts fails', () => {
        let commsAdapter: ICommsAdapter
        let listRoomsWithParticipantCountsMock: jest.Mock

        beforeEach(async () => {
          const config = await createConfigComponent({
            PULSE_URL: 'https://pulse.example.com',
            COMMS_ADAPTER: 'livekit',
            COMMS_ROOM_PREFIX: 'world-',
            SCENE_ROOM_PREFIX: 'scene-',
            LIVEKIT_HOST: 'livekit.dcl.org',
            LIVEKIT_API_KEY: 'myApiKey',
            LIVEKIT_API_SECRET: 'myApiSecret'
          })
          const logs = await createLogComponent({ config })
          listRoomsWithParticipantCountsMock = jest.fn().mockRejectedValue(new Error('Chunk request failed'))
          const livekitClient = createMockLivekitClient({
            listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
          })
          const fetch: IFetchComponent = {
            fetch: async (_url: Request): Promise<Response> => new Response(undefined)
          }
          commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
        })

        it('should return 0 rather than fail the capacity check', async () => {
          expect(await commsAdapter.getWorldRoomParticipantCount('any-world.dcl.eth')).toBe(0)
        })

        it('should have called listRoomsWithParticipantCounts', async () => {
          await commsAdapter.getWorldRoomParticipantCount('any-world.dcl.eth')

          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
        })
      })
    })

    describe('when getting scene room participant counts', () => {
      let commsAdapter: ICommsAdapter
      let listRoomsWithParticipantCountsMock: jest.Mock

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
          COMMS_ADAPTER: 'livekit',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'scene-',
          LIVEKIT_HOST: 'livekit.dcl.org',
          LIVEKIT_API_KEY: 'myApiKey',
          LIVEKIT_API_SECRET: 'myApiSecret'
        })
        const logs = await createLogComponent({ config })
        listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue([
          { name: 'scene-sample.dcl.eth-scene1', numParticipants: 4 },
          { name: 'scene-sample.dcl.eth-scene2', numParticipants: 3 }
        ])
        const livekitClient = createMockLivekitClient({
          listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
        })
        const fetch: IFetchComponent = {
          fetch: async (_url: Request): Promise<Response> => new Response(undefined)
        }
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
      })

      it('should return the sum of participant counts', async () => {
        expect(await commsAdapter.getWorldSceneRoomsParticipantCount('sample.dcl.eth')).toBe(7)
      })

      it('should call listRoomsWithParticipantCounts with the scene room prefix for the world', async () => {
        await commsAdapter.getWorldSceneRoomsParticipantCount('sample.dcl.eth')
        expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledTimes(1)
        expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({
          namePrefix: 'scene-sample.dcl.eth-'
        })
      })
    })

    describe('when removing a participant', () => {
      let commsAdapter: ICommsAdapter
      let removeParticipantMock: jest.Mock

      beforeEach(async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
          COMMS_ADAPTER: 'livekit',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'scene-',
          LIVEKIT_HOST: 'livekit.dcl.org',
          LIVEKIT_API_KEY: 'myApiKey',
          LIVEKIT_API_SECRET: 'myApiSecret'
        })
        const logs = await createLogComponent({ config })
        removeParticipantMock = jest.fn().mockResolvedValue(undefined)
        const livekitClient = createMockLivekitClient({
          removeParticipant: removeParticipantMock
        })
        const fetch: IFetchComponent = {
          fetch: async (_url: Request): Promise<Response> => new Response(undefined)
        }
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
      })

      it('should delegate to livekitClient.removeParticipant', async () => {
        await commsAdapter.removeParticipant('world-sample.dcl.eth', '0xuser123')
        expect(removeParticipantMock).toHaveBeenCalledWith('world-sample.dcl.eth', '0xuser123')
      })
    })

    describe('when LIVEKIT_HOST is not configured', () => {
      it('should refuse to initialize', async () => {
        const config = await createConfigComponent({
          PULSE_URL: 'https://pulse.example.com',
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
    })
  })

  describe('when adapter type is invalid', function () {
    it('should refuse to initialize', async () => {
      const config = await createConfigComponent({
        PULSE_URL: 'https://pulse.example.com',
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

  describe('presence', function () {
    const realmsGolden = loadHttpGolden<PulseRealmsBody>('realms')
    const PULSE_URL = 'https://pulse.example.com'

    let logs: jest.Mocked<ILoggerComponent>
    let logger: jest.Mocked<ILoggerComponent.ILogger>
    let livekitClient: LivekitClient
    let fetchMock: jest.Mock

    beforeEach(() => {
      logs = createMockLogs()
      logger = logs.getLogger('any') as unknown as jest.Mocked<ILoggerComponent.ILogger>
      fetchMock = jest.fn().mockImplementation(async () => new Response(JSON.stringify(realmsGolden.body)))
      livekitClient = createMockLivekitClient({
        listRoomsWithParticipantCounts: jest
          .fn()
          .mockResolvedValue([{ name: 'world-cozyfarm.dcl.eth', numParticipants: 1 }])
      })
    })

    async function buildLivekitBackedAdapter(overrides: Record<string, string>): Promise<ICommsAdapter> {
      const config = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: 'secret',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'world-scene-room-',
        PULSE_URL,
        ...overrides
      })
      return createCommsAdapterComponent({
        config,
        fetch: { fetch: fetchMock } as unknown as IFetchComponent,
        logs,
        livekitClient
      })
    }

    // WP5-boot-requires-PULSE_URL: there is no fallback left to degrade to, so a missing or
    // malformed Pulse URL fails the boot instead of silently keeping a LiveKit-only service alive.
    describe('when PULSE_URL is missing', () => {
      it('should refuse to initialize', async () => {
        const config = await createConfigComponent({
          COMMS_ADAPTER: 'livekit',
          LIVEKIT_HOST: 'livekit.dcl.org',
          LIVEKIT_API_KEY: 'key',
          LIVEKIT_API_SECRET: 'secret',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'world-scene-room-'
        })

        await expect(
          createCommsAdapterComponent({
            config,
            fetch: { fetch: fetchMock } as unknown as IFetchComponent,
            logs,
            livekitClient
          })
        ).rejects.toThrow('Configuration: string PULSE_URL is required')
      })
    })

    describe('when PULSE_URL is not an absolute http(s) URL', () => {
      it('should refuse a value that is not a URL at all', async () => {
        await expect(buildLivekitBackedAdapter({ PULSE_URL: 'not-a-url' })).rejects.toThrow(
          'Configuration: string PULSE_URL must be an absolute http(s) URL, got "not-a-url"'
        )
      })

      it('should refuse a non-http(s) scheme', async () => {
        await expect(buildLivekitBackedAdapter({ PULSE_URL: 'ftp://pulse.example.com' })).rejects.toThrow(
          'Configuration: string PULSE_URL must be an absolute http(s) URL, got "ftp://pulse.example.com"'
        )
      })
    })

    describe('when resolving status', () => {
      let commsAdapter: ICommsAdapter
      let status: CommsStatus

      beforeEach(async () => {
        commsAdapter = await buildLivekitBackedAdapter({})
        status = await commsAdapter.status()
      })

      it('should read the world counts from the Pulse realms endpoint', () => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
      })

      it('should not read the counters from LiveKit', () => {
        expect(livekitClient.listRoomsWithParticipantCounts).not.toHaveBeenCalled()
      })

      it('should keep describing the transport in adapterType and statusUrl', () => {
        expect(status.adapterType).toBe('livekit')
        expect(status.statusUrl).toBe('https://livekit.dcl.org/')
      })

      it('should report only the realms that are worlds', () => {
        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
      })

      it('should sum users and rooms over the world realms', () => {
        expect(status.users).toBe(1)
        expect(status.rooms).toBe(1)
      })

      it('should timestamp the answer with the Pulse lastUpdated', () => {
        expect(new Date(status.timestamp).toISOString()).toBe(realmsGolden.body.lastUpdated)
      })

      it('should read Pulse once per TTL, not once per request', async () => {
        await commsAdapter.status()
        await commsAdapter.status()

        expect(fetchMock).toHaveBeenCalledTimes(1)
      })

      it('should not invent a commit hash the transport does not publish', () => {
        // The livekit transport never sets `commitHash`, so neither may the Pulse-sourced answer:
        // the `/status` `comms` key set must not depend on which transport is configured.
        expect('commitHash' in status).toBe(false)
      })

      it('should still resolve the capacity-check participant count from LiveKit', async () => {
        // iteration-2 exception: the capacity gate stays on LiveKit regardless of the presence
        // counters `/live-data` and `/status` publish.
        await commsAdapter.getWorldRoomParticipantCount('cozyfarm.dcl.eth')

        expect(livekitClient.listRoomsWithParticipantCounts).toHaveBeenCalled()
      })
    })

    // C4-live-data: `worldName` stays lowercase whatever Pulse puts on the wire, and a realm with
    // no peers is dropped exactly like an empty LiveKit room, so the published shape does not depend
    // on the transport underneath.
    describe('when Pulse answers with a mixed-case and an empty realm', () => {
      let status: CommsStatus

      beforeEach(async () => {
        fetchMock.mockImplementation(
          async () =>
            new Response(
              JSON.stringify({
                realms: [
                  { name: 'main', peers: 4, clusters: 2 },
                  { name: 'CozyFarm.dcl.eth', peers: 2, clusters: 1 },
                  { name: 'draining.dcl.eth', peers: 0, clusters: 1 }
                ],
                lastUpdated: realmsGolden.body.lastUpdated
              })
            )
        )
        status = await (await buildLivekitBackedAdapter({})).status()
      })

      it('should publish the world name lowercased', () => {
        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 2 }])
      })

      it('should count neither the empty world nor Genesis City', () => {
        expect(status.rooms).toBe(1)
        expect(status.users).toBe(2)
      })

      it('should log the casing contract violation', () => {
        expect(logger.warn).toHaveBeenCalledWith(
          'Pulse answered /realms with non-lowercase realm names; normalizing them',
          { realms: 'CozyFarm.dcl.eth' }
        )
      })
    })

    describe('when the transport is ws-room', () => {
      let status: CommsStatus

      beforeEach(async () => {
        // The ws-room transport is the only one that publishes `commitHash`, from its own /status
        // payload, so the mock has to answer both endpoints.
        fetchMock.mockImplementation(async (url: string) =>
          url.endsWith('/realms')
            ? new Response(JSON.stringify(realmsGolden.body))
            : new Response(JSON.stringify({ commitHash: 'ws-room-commit', details: [] }))
        )
        const config = await createConfigComponent({
          COMMS_ADAPTER: 'ws-room',
          COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'world-scene-room-',
          PULSE_URL
        })
        const commsAdapter = await createCommsAdapterComponent({
          config,
          fetch: { fetch: fetchMock } as unknown as IFetchComponent,
          logs,
          livekitClient
        })
        status = await commsAdapter.status()
      })

      it('should read the world counts from the Pulse realms endpoint', () => {
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/realms'))).toHaveLength(1)
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
      })

      it('should keep describing the transport in adapterType and statusUrl', () => {
        expect(status.adapterType).toBe('ws-room')
        expect(status.statusUrl).toBe('https://ws-room-service.decentraland.org/status')
      })

      it('should keep publishing the commit hash the transport supplies', () => {
        expect(status.commitHash).toBe('ws-room-commit')
      })

      it('should report the same world counts as the livekit transport', () => {
        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
      })
    })

    describe('when the transport is ws-room and the transport is down', () => {
      let status: CommsStatus

      beforeEach(async () => {
        fetchMock.mockImplementation(async (url: string) => {
          if (url.endsWith('/realms')) {
            return new Response(JSON.stringify(realmsGolden.body))
          }
          throw new Error('ws-room is down')
        })
        const config = await createConfigComponent({
          COMMS_ADAPTER: 'ws-room',
          COMMS_FIXED_ADAPTER: 'ws-room:ws-room-service.decentraland.org/rooms/test-scene',
          COMMS_ROOM_PREFIX: 'world-',
          SCENE_ROOM_PREFIX: 'world-scene-room-',
          PULSE_URL
        })
        const commsAdapter = await createCommsAdapterComponent({
          config,
          fetch: { fetch: fetchMock } as unknown as IFetchComponent,
          logs,
          livekitClient
        })
        status = await commsAdapter.status()
      })

      it('should still serve the Pulse counters', () => {
        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
        expect(status.users).toBe(1)
      })

      it('should drop the commit hash rather than the answer', () => {
        expect(status.commitHash).toBeUndefined()
      })
    })

    // C4-no-fallback: a Pulse outage never falls back to a LiveKit-derived count. The first failure
    // after a successful read still serves the last successful answer (one extra cache TTL of
    // grace); only once that grace elapses too does `status()` reject, so the handler can answer
    // `503` instead.
    describe('when Pulse fails after a successful read', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        jest.useFakeTimers()
        commsAdapter = await buildLivekitBackedAdapter({})
        await commsAdapter.status()
        fetchMock.mockRejectedValue(new Error('pulse is down'))
      })

      afterEach(() => {
        jest.useRealTimers()
      })

      it('should keep serving the last successful answer for one more cache TTL', async () => {
        await jest.advanceTimersByTimeAsync(STATUS_CACHE_TTL_MS + 1)

        const status = await commsAdapter.status()

        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
        expect(livekitClient.listRoomsWithParticipantCounts).not.toHaveBeenCalled()
      })

      it('should reject once the stale grace period elapses too, never falling back to LiveKit', async () => {
        await jest.advanceTimersByTimeAsync(STATUS_CACHE_TTL_MS + 1)
        await commsAdapter.status()

        await jest.advanceTimersByTimeAsync(STATUS_CACHE_TTL_MS + 1)

        await expect(commsAdapter.status()).rejects.toThrow('Pulse presence is unavailable')
        expect(livekitClient.listRoomsWithParticipantCounts).not.toHaveBeenCalled()
      })
    })

    describe('when Pulse has never answered successfully', () => {
      it('should reject rather than falling back to LiveKit', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))

        const commsAdapter = await buildLivekitBackedAdapter({})

        await expect(commsAdapter.status()).rejects.toThrow('Pulse presence is unavailable')
        expect(livekitClient.listRoomsWithParticipantCounts).not.toHaveBeenCalled()
      })

      // `cachedAt` deliberately only advances on a success (it is what caps total staleness at
      // ~2xTTL), but that means every cache miss during an outage used to start its own fresh Pulse
      // read: Pulse fails fast, so `pendingRead` only folds truly concurrent callers, and the outbound
      // rate against a service that is already down tracked the inbound rate of two public,
      // unthrottled routes. At most one read may be *started* per cache TTL.
      it('should throttle upstream reads to at most one per cache TTL', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))
        const commsAdapter = await buildLivekitBackedAdapter({})

        for (let i = 0; i < 10; i++) {
          await commsAdapter.status().catch(() => undefined)
        }

        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
    })

    // C4-no-fallback / C4-live-data-shape: a 200 whose body is not `{ realms: [...] }` must be
    // treated exactly like a Pulse outage -- the stale-then-503 machinery, never an invented "empty
    // healthy" answer with a locally-generated `lastUpdated`.
    describe('when Pulse answers 200 with a malformed body', () => {
      it.each([
        ['a gateway error envelope', { message: 'upstream connect error' }],
        ['an empty object', {}],
        ['a bare JSON string', 'not json']
      ])('should reject rather than serving an empty world list (%s)', async (_name, malformedBody) => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(malformedBody)))

        const commsAdapter = await buildLivekitBackedAdapter({})

        await expect(commsAdapter.status()).rejects.toThrow('Pulse presence is unavailable')
        expect(livekitClient.listRoomsWithParticipantCounts).not.toHaveBeenCalled()
      })

      it('should serve the last successful answer for one more cache TTL, then reject, exactly like a genuine outage', async () => {
        jest.useFakeTimers()
        try {
          const commsAdapter = await buildLivekitBackedAdapter({})
          await commsAdapter.status()

          fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'upstream connect error' })))

          await jest.advanceTimersByTimeAsync(STATUS_CACHE_TTL_MS + 1)
          const stale = await commsAdapter.status()
          expect(stale.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])

          await jest.advanceTimersByTimeAsync(STATUS_CACHE_TTL_MS + 1)
          await expect(commsAdapter.status()).rejects.toThrow('Pulse presence is unavailable')
        } finally {
          jest.useRealTimers()
        }
      })
    })
  })
})
