import { createConfigComponent } from '@well-known-components/env-config-provider'
import { IFetchComponent } from '@dcl/core-commons'
import { createCommsAdapterComponent } from '../../src/adapters/comms-adapter'
import { createLogComponent } from '@well-known-components/logger'
import { createMockLivekitClient } from '../mocks/livekit-client-mock'
import { CommsStatus, ICommsAdapter } from '../../src/types'

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
          livekitClient: createMockLivekitClient()
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
            livekitClient: createMockLivekitClient()
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
            livekitClient: createMockLivekitClient()
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
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
          const commsAdapter = await createCommsAdapterComponent({ config, fetch, logs, livekitClient })
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
