import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IFetchComponent } from '@dcl/core-commons'
import { createCommsAdapterComponent, presenceSourcedAdapter } from '../../src/adapters/comms-adapter'
import { createLogComponent } from '@well-known-components/logger'
import { createTestMetricsComponent } from '@dcl/metrics'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createMockCommsAdapterComponent } from '../mocks/comms-adapter-mock'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { metricDeclarations } from '../../src/metrics'
import { CommsStatus, ICommsAdapter, LivekitClient } from '../../src/types'
import { loadHttpGolden, PulseRealmsBody } from '../fixtures/iteration-2/http-goldens'
import { PULSE_REQUEST_TIMEOUT_MS } from '../../src/logic/presence-source'

const metrics = createTestMetricsComponent(metricDeclarations)

describe('comms-adapter', function () {
  describe('ws-room', function () {
    describe('when resolving connection string', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
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
          livekitClient: createMockLivekitClient(),
          metrics
        })
      })

      it('should return the prefixed room URL', async () => {
        expect(await commsAdapter.getWorldRoomConnectionString('0xA', 'my-room')).toBe(
          'ws-room:ws-room-service.decentraland.org/rooms/world-prd-my-room'
        )
      })
    })

    describe('when resolving status', () => {
      describe('and rooms contain active and empty rooms', () => {
        let status: CommsStatus

        beforeEach(async () => {
          const config = await createConfigComponent({
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
            livekitClient: createMockLivekitClient(),
            metrics
          })
          status = await commsAdapter.status()
        })

        it('should return only rooms with active users', () => {
          expect(status).toMatchObject({
            rooms: 1,
            users: 2,
            details: [{ users: 2, worldName: 'sample.dcl.eth' }]
          })
        })
      })

      describe('and scene room prefix starts with world room prefix', () => {
        let status: CommsStatus

        beforeEach(async () => {
          const config = await createConfigComponent({
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
          const commsAdapter = await createCommsAdapterComponent({
            config,
            fetch,
            logs,
            livekitClient: createMockLivekitClient(),
            metrics
          })
          status = await commsAdapter.status()
        })

        it('should exclude scene rooms from the details', () => {
          expect(status.details).toEqual([{ worldName: 'sheficlub.dcl.eth', users: 71 }])
        })

        it('should return the correct rooms count', () => {
          expect(status.rooms).toBe(1)
        })

        it('should return the correct users count', () => {
          expect(status.users).toBe(71)
        })
      })
    })

    describe('when getting room participant count from cached status', () => {
      let commsAdapter: ICommsAdapter

      beforeEach(async () => {
        const config = await createConfigComponent({
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
          livekitClient: createMockLivekitClient(),
          metrics
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
          livekitClient: createMockLivekitClient(),
          metrics
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
          livekitClient: createMockLivekitClient(),
          metrics
        })
      })

      it('should resolve without throwing', async () => {
        await expect(commsAdapter.removeParticipant('world-prd-sample.dcl.eth', '0xuser123')).resolves.toBeUndefined()
      })
    })

    describe('when COMMS_FIXED_ADAPTER is not configured', () => {
      it('should refuse to initialize', async () => {
        const config = await createConfigComponent({
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
            livekitClient: createMockLivekitClient(),
            metrics
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
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
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

    describe('when resolving status', () => {
      describe('and rooms have active users', () => {
        let status: CommsStatus
        let listRoomsWithParticipantCountsMock: jest.Mock

        beforeEach(async () => {
          const config = await createConfigComponent({
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
          status = await commsAdapter.status()
        })

        it('should return the room details with stripped prefixes', () => {
          expect(status).toMatchObject({
            rooms: 2,
            users: 4,
            details: [
              { users: 3, worldName: 'prd-sample.dcl.eth' },
              { users: 1, worldName: 'prd-another-world.dcl.eth' }
            ]
          })
        })

        it('should call listRoomsWithParticipantCounts with the world room prefix', () => {
          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledTimes(1)
          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
        })
      })

      describe('and scene room prefix starts with world room prefix', () => {
        let status: CommsStatus

        beforeEach(async () => {
          const config = await createConfigComponent({
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
          status = await commsAdapter.status()
        })

        it('should exclude scene rooms from the details', () => {
          expect(status.details).toEqual([{ worldName: 'sheficlub.dcl.eth', users: 71 }])
        })

        it('should return the correct rooms count', () => {
          expect(status.rooms).toBe(1)
        })

        it('should return the correct users count', () => {
          expect(status.users).toBe(71)
        })
      })

      describe('and many rooms are returned', () => {
        let status: CommsStatus
        let listRoomsWithParticipantCountsMock: jest.Mock
        let expectedUsers: number

        beforeEach(async () => {
          const config = await createConfigComponent({
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
          expectedUsers = roomsWithCounts.reduce((s, r) => s + r.numParticipants, 0)
          listRoomsWithParticipantCountsMock = jest.fn().mockResolvedValue(roomsWithCounts)
          const livekitClient = createMockLivekitClient({
            listRoomsWithParticipantCounts: listRoomsWithParticipantCountsMock
          })
          const fetch: IFetchComponent = {
            fetch: async (_url: Request): Promise<Response> => new Response(undefined)
          }
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
          status = await commsAdapter.status()
        })

        it('should return all rooms in details', () => {
          expect(status.rooms).toBe(12)
          expect(status.details).toHaveLength(12)
        })

        it('should compute the correct users total', () => {
          expect(status.users).toBe(expectedUsers)
        })

        it('should call listRoomsWithParticipantCounts with the world room prefix', () => {
          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
        })
      })

      describe('and listRoomsWithParticipantCounts fails', () => {
        let status: CommsStatus
        let listRoomsWithParticipantCountsMock: jest.Mock

        beforeEach(async () => {
          const config = await createConfigComponent({
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
          status = await commsAdapter.status()
        })

        it('should return a livekit adapter type', () => {
          expect(status.adapterType).toBe('livekit')
        })

        it('should return 0 rooms and 0 users', () => {
          expect(status.rooms).toBe(0)
          expect(status.users).toBe(0)
        })

        it('should return empty details', () => {
          expect(status.details).toHaveLength(0)
        })

        it('should have called listRoomsWithParticipantCounts', () => {
          expect(listRoomsWithParticipantCountsMock).toHaveBeenCalledWith({ namePrefix: 'world-' })
        })
      })
    })

    describe('when getting scene room participant counts', () => {
      let commsAdapter: ICommsAdapter
      let listRoomsWithParticipantCountsMock: jest.Mock

      beforeEach(async () => {
        const config = await createConfigComponent({
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
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
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
        commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient, metrics })
      })

      it('should delegate to livekitClient.removeParticipant', async () => {
        await commsAdapter.removeParticipant('world-sample.dcl.eth', '0xuser123')
        expect(removeParticipantMock).toHaveBeenCalledWith('world-sample.dcl.eth', '0xuser123')
      })
    })

    describe('when LIVEKIT_HOST is not configured', () => {
      it('should refuse to initialize', async () => {
        const config = await createConfigComponent({
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
            livekitClient: createMockLivekitClient(),
            metrics
          })
        ).rejects.toThrow('Configuration: string LIVEKIT_HOST is required')
      })
    })
  })

  describe('when adapter type is invalid', function () {
    it('should refuse to initialize', async () => {
      const config = await createConfigComponent({
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
          livekitClient: createMockLivekitClient(),
          metrics
        })
      ).rejects.toThrow('Invalid comms adapter: other')
    })
  })

  describe('presence source', function () {
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

    /**
     * `both` fires the Pulse shadow comparison *off* the served request path, so a case that
     * asserts on the comparison has to let that background work settle first. `setImmediate` drains
     * the microtask queue and the pending I/O callbacks the mocked `Response.json()` needs; a few
     * passes cover the whole fetch -> json -> record chain.
     */
    async function flushShadowComparison(): Promise<void> {
      for (let pass = 0; pass < 5; pass += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    function buildShadowingAdapter(transportStatus: jest.Mock): ICommsAdapter {
      return presenceSourcedAdapter(
        { fetch: { fetch: fetchMock } as unknown as IFetchComponent, logs, metrics },
        { ...createMockCommsAdapterComponent(), status: transportStatus },
        {
          presenceSource: 'both',
          pulseUrl: PULSE_URL,
          adapterType: 'livekit',
          statusUrl: 'https://livekit.dcl.org/',
          publishesCommitHash: false
        }
      )
    }

    function livekitStatus(details: { worldName: string; users: number }[]): CommsStatus {
      return {
        adapterType: 'livekit',
        statusUrl: 'https://livekit.dcl.org/',
        rooms: details.length,
        users: details.reduce((carry, detail) => carry + detail.users, 0),
        details,
        timestamp: Date.now()
      }
    }

    async function buildLivekitBackedAdapter(overrides: Record<string, string>): Promise<ICommsAdapter> {
      const config = await createConfigComponent({
        COMMS_ADAPTER: 'livekit',
        LIVEKIT_HOST: 'livekit.dcl.org',
        LIVEKIT_API_KEY: 'key',
        LIVEKIT_API_SECRET: 'secret',
        COMMS_ROOM_PREFIX: 'world-',
        SCENE_ROOM_PREFIX: 'world-scene-room-',
        ...overrides
      })
      return createCommsAdapterComponent({
        config,
        fetch: { fetch: fetchMock } as unknown as IFetchComponent,
        logs,
        livekitClient,
        metrics
      })
    }

    describe('when PRESENCE_SOURCE is not configured', () => {
      let status: CommsStatus

      beforeEach(async () => {
        status = await (await buildLivekitBackedAdapter({})).status()
      })

      it('should keep counting from the transport', () => {
        expect(livekitClient.listRoomsWithParticipantCounts).toHaveBeenCalled()
        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
      })

      it('should not call Pulse at all', () => {
        expect(fetchMock).not.toHaveBeenCalled()
      })
    })

    describe('when PRESENCE_SOURCE has an unknown value', () => {
      it('should fall back to the transport counters', async () => {
        await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'nonsense' })).status()

        expect(livekitClient.listRoomsWithParticipantCounts).toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      })
    })

    describe('when PRESENCE_SOURCE is pulse but PULSE_URL is missing', () => {
      it('should refuse to initialize', async () => {
        await expect(buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'pulse' })).rejects.toThrow(
          'Configuration: string PULSE_URL is required'
        )
      })
    })

    describe('when PRESENCE_SOURCE is pulse', () => {
      let commsAdapter: ICommsAdapter
      let status: CommsStatus

      beforeEach(async () => {
        commsAdapter = await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'pulse', PULSE_URL })
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
        // The wrapper's own cache is the *only* layer in front of the Pulse-sourced answer, and it
        // mirrors the transport adapter's TTL so swapping the source does not change how often the
        // upstream is polled.
        await commsAdapter.status()
        await commsAdapter.status()

        expect(fetchMock).toHaveBeenCalledTimes(1)
      })

      it('should not invent a commit hash the transport does not publish', () => {
        // The livekit transport never sets `commitHash`, so neither may the Pulse-sourced answer:
        // the `/status` `comms` key set must not drift with the presence source.
        expect('commitHash' in status).toBe(false)
      })

      it('should still resolve the capacity-check participant count from LiveKit', async () => {
        await commsAdapter.getWorldRoomParticipantCount('cozyfarm.dcl.eth')

        expect(livekitClient.listRoomsWithParticipantCounts).toHaveBeenCalled()
      })
    })

    // C4-live-data: `worldName` stays lowercase whatever Pulse puts on the wire, and a realm with
    // no peers is dropped exactly like an empty LiveKit room, so the two sources answer the same
    // world set.
    describe('when PRESENCE_SOURCE is pulse and Pulse answers with a mixed-case and an empty realm', () => {
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
        status = await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'pulse', PULSE_URL })).status()
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

    describe('when PRESENCE_SOURCE is pulse and Pulse is unreachable', () => {
      it('should answer with an empty world list rather than failing', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))

        const status = await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'pulse', PULSE_URL })).status()

        expect(status).toMatchObject({ adapterType: 'livekit', rooms: 0, users: 0, details: [] })
      })
    })

    describe('when PRESENCE_SOURCE is pulse and the transport is ws-room', () => {
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
          PRESENCE_SOURCE: 'pulse',
          PULSE_URL
        })
        const commsAdapter = await createCommsAdapterComponent({
          config,
          fetch: { fetch: fetchMock } as unknown as IFetchComponent,
          logs,
          livekitClient,
          metrics
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

    describe('when PRESENCE_SOURCE is pulse, the transport is ws-room and the transport is down', () => {
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
          PRESENCE_SOURCE: 'pulse',
          PULSE_URL
        })
        const commsAdapter = await createCommsAdapterComponent({
          config,
          fetch: { fetch: fetchMock } as unknown as IFetchComponent,
          logs,
          livekitClient,
          metrics
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

    describe('when PRESENCE_SOURCE is both', () => {
      let status: CommsStatus
      let incrementSpy: jest.SpyInstance

      beforeEach(async () => {
        incrementSpy = jest.spyOn(metrics, 'increment')
        livekitClient = createMockLivekitClient({
          listRoomsWithParticipantCounts: jest.fn().mockResolvedValue([
            { name: 'world-cozyfarm.dcl.eth', numParticipants: 2 },
            { name: 'world-only-in-livekit.dcl.eth', numParticipants: 3 }
          ])
        })
        status = await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'both', PULSE_URL })).status()
        await flushShadowComparison()
      })

      afterEach(() => {
        incrementSpy.mockRestore()
      })

      it('should serve the LiveKit answer', () => {
        expect(status.users).toBe(5)
        expect(status.details).toEqual([
          { worldName: 'cozyfarm.dcl.eth', users: 2 },
          { worldName: 'only-in-livekit.dcl.eth', users: 3 }
        ])
      })

      it('should also read Pulse', () => {
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
      })

      it('should count the divergence under presence_shadow_diff{kind=live-data}', () => {
        // cozyfarm.dcl.eth: 2 users on LiveKit vs 1 on Pulse -> one world with a user delta.
        // only-in-livekit.dcl.eth: absent from Pulse -> one world only on the LiveKit side.
        expect(incrementSpy).toHaveBeenCalledWith('presence_shadow_diff', { kind: 'live-data' }, 2)
      })

      it('should count the size of the divergence under presence_shadow_diff{kind=live-data-users}', () => {
        // Without this series WP10 cannot tell one world off by 1 from one world off by 1000 —
        // both are a single `kind=live-data` increment. cozyfarm.dcl.eth is 2 on LiveKit and 1 on
        // Pulse, so the magnitude is |2 - 1| = 1.
        expect(incrementSpy).toHaveBeenCalledWith('presence_shadow_diff', { kind: 'live-data-users' }, 1)
      })

      it('should log the divergence as counts only, never wallets', () => {
        expect(logger.info).toHaveBeenCalledWith('Presence shadow comparison', {
          kind: 'live-data',
          onlyInLivekit: 1,
          onlyInPulse: 0,
          worldsWithUserDelta: 1,
          totalUsersDelta: 1,
          livekitWorlds: 2,
          pulseWorlds: 1,
          livekitUsers: 5,
          pulseUsers: 1
        })
      })
    })

    // WP5's dual-source window exists to serve the *LiveKit* answer while Pulse is compared against
    // it, so the comparison must never be able to delay a public request: a Pulse that accepts the
    // connection and then stalls (a wedged pod, a hung DB read) would otherwise turn one /live-data
    // or /status request per TTL into a hang, on two routes that today never touch Pulse.
    describe('when PRESENCE_SOURCE is both and Pulse stalls after accepting the connection', () => {
      let servedStatus: CommsStatus

      beforeEach(async () => {
        jest.useFakeTimers()
        fetchMock.mockImplementation(() => new Promise<Response>(() => undefined))

        // No timer is advanced before this resolves, so it can only resolve if the served answer
        // does not wait for the shadow read.
        servedStatus = await buildShadowingAdapter(
          jest.fn().mockResolvedValue(livekitStatus([{ worldName: 'cozyfarm.dcl.eth', users: 1 }]))
        ).status()
      })

      afterEach(() => {
        jest.useRealTimers()
      })

      it('should serve the transport answer without waiting for Pulse', () => {
        expect(servedStatus.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
      })

      it('should still have started the Pulse read', () => {
        expect(fetchMock).toHaveBeenCalledWith(`${PULSE_URL}/realms`, expect.anything())
      })

      it('should not have reported anything while the read is still in flight', () => {
        expect(logger.warn).not.toHaveBeenCalled()
      })

      it('should abandon the stalled shadow at the deadline and log it exactly once', async () => {
        await jest.advanceTimersByTimeAsync(PULSE_REQUEST_TIMEOUT_MS)

        expect(logger.warn.mock.calls.flat()).toEqual([
          `Error retrieving the Pulse presence shadow: Pulse request timed out after ${PULSE_REQUEST_TIMEOUT_MS} ms`
        ])
      })
    })

    describe('when PRESENCE_SOURCE is both and status is asked for twice', () => {
      // `both` must not stack a second cache in front of the transport adapter's own 60 s cache:
      // two layers in series let `/live-data` serve an answer up to 2xTTL old and make every shadow
      // comparison pair a fresh Pulse read with a LiveKit answer up to a TTL stale, biasing the
      // recorded divergence towards "LiveKit is behind" exactly while WP10 reads it. So every call
      // reaches the transport adapter (whose cache is the only layer), while the *comparison* stays
      // throttled to one Pulse read per TTL.
      let transportStatus: jest.Mock

      beforeEach(async () => {
        transportStatus = jest.fn().mockResolvedValue({
          adapterType: 'livekit',
          statusUrl: 'https://livekit.dcl.org/',
          rooms: 1,
          users: 1,
          details: [{ worldName: 'cozyfarm.dcl.eth', users: 1 }],
          timestamp: Date.now()
        })
        const commsAdapter = presenceSourcedAdapter(
          { fetch: { fetch: fetchMock } as unknown as IFetchComponent, logs, metrics },
          { ...createMockCommsAdapterComponent(), status: transportStatus },
          {
            presenceSource: 'both',
            pulseUrl: PULSE_URL,
            adapterType: 'livekit',
            statusUrl: 'https://livekit.dcl.org/',
            publishesCommitHash: false
          }
        )

        await commsAdapter.status()
        await commsAdapter.status()
      })

      it('should ask the transport adapter every time instead of caching its answer again', () => {
        expect(transportStatus).toHaveBeenCalledTimes(2)
      })

      it('should still read Pulse only once per TTL', () => {
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })
    })

    describe('when PRESENCE_SOURCE is both and the two sources agree', () => {
      it('should still create both shadow series with a zero increment', async () => {
        // WP10 reads Prometheus: an absent series is indistinguishable from "not deployed", so the
        // increment happens even when there is nothing to report. The default livekit mock and the
        // golden describe the same world set (cozyfarm.dcl.eth with one peer).
        const incrementSpy = jest.spyOn(metrics, 'increment')

        try {
          await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'both', PULSE_URL })).status()
          await flushShadowComparison()

          expect(incrementSpy).toHaveBeenCalledWith('presence_shadow_diff', { kind: 'live-data' }, 0)
          expect(incrementSpy).toHaveBeenCalledWith('presence_shadow_diff', { kind: 'live-data-users' }, 0)
        } finally {
          incrementSpy.mockRestore()
        }
      })
    })

    describe('when PRESENCE_SOURCE is both and Pulse is unreachable', () => {
      it('should still serve the LiveKit answer', async () => {
        fetchMock.mockRejectedValue(new Error('pulse is down'))

        const status = await (await buildLivekitBackedAdapter({ PRESENCE_SOURCE: 'both', PULSE_URL })).status()

        expect(status.details).toEqual([{ worldName: 'cozyfarm.dcl.eth', users: 1 }])
      })
    })

    describe('when PRESENCE_SOURCE is both and the transport is unreachable', () => {
      let status: CommsStatus

      beforeEach(async () => {
        // The ws-room transport propagates its fetch failure, so the caching adapter has no answer
        // and no stale value to fall back on; Pulse answers normally.
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
          PRESENCE_SOURCE: 'both',
          PULSE_URL
        })
        const commsAdapter = await createCommsAdapterComponent({
          config,
          fetch: { fetch: fetchMock } as unknown as IFetchComponent,
          logs,
          livekitClient,
          metrics
        })
        status = await commsAdapter.status()
      })

      it('should answer with an empty status rather than fail', () => {
        expect(status).toMatchObject({ adapterType: 'ws-room', rooms: 0, users: 0, details: [] })
      })

      it('should skip the shadow comparison instead of logging a bogus one', () => {
        expect(logger.info).not.toHaveBeenCalledWith('Presence shadow comparison', expect.anything())
      })

      it('should report the transport outage and nothing else', () => {
        // Comparing against a missing transport answer used to throw, which the status cache then
        // logged a second time as `Error retrieving comms status: Cannot read properties of
        // undefined`. Only the transport's own failure should be reported.
        expect(logger.warn.mock.calls.flat()).toEqual(['Error retrieving comms status: ws-room is down'])
      })
    })
  })
})
