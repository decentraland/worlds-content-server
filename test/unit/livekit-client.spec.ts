import { WebhookEvent, WebhookReceiver } from 'livekit-server-sdk'
import { createLivekitClient } from '../../src/adapters/livekit-client'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { LivekitClient } from '../../src/types'

const mockListRooms = jest.fn()

jest.mock('livekit-server-sdk', () => {
  const actual = jest.requireActual<typeof import('livekit-server-sdk')>('livekit-server-sdk')
  return {
    ...actual,
    RoomServiceClient: jest.fn().mockImplementation(() => ({
      listRooms: mockListRooms
    })),
    AccessToken: actual.AccessToken
  }
})

describe('LivekitClient', () => {
  let config: IConfigComponent
  let livekitClient: LivekitClient

  beforeEach(async () => {
    jest.clearAllMocks()
    config = createConfigComponent({
      LIVEKIT_HOST: 'livekit.example.com',
      LIVEKIT_API_KEY: 'test_api_key',
      LIVEKIT_API_SECRET: 'test_api_secret'
    })
    livekitClient = await createLivekitClient({ config })
  })

  it('should receive webhook events correctly', async () => {
    const mockEvent = {
      event: 'participant_joined',
      participant: { identity: 'test' },
      room: { name: 'test' }
    } as WebhookEvent

    jest.spyOn(WebhookReceiver.prototype, 'receive').mockResolvedValue(mockEvent)

    const result = await livekitClient.receiveWebhookEvent('test-body', 'test-auth')

    expect(result).toEqual(mockEvent)
    expect(WebhookReceiver.prototype.receive).toHaveBeenCalledWith('test-body', 'test-auth')
  })

  describe('getRoom', () => {
    it('should return room when it exists', async () => {
      const room = { name: 'world-sample.dcl.eth', numParticipants: 3 }
      mockListRooms.mockResolvedValue([room])

      const result = await livekitClient.getRoom('world-sample.dcl.eth')

      expect(result).toEqual(room)
      expect(mockListRooms).toHaveBeenCalledWith(['world-sample.dcl.eth'])
    })

    it('should return null when room does not exist', async () => {
      mockListRooms.mockResolvedValue([])

      const result = await livekitClient.getRoom('world-nonexistent.dcl.eth')

      expect(result).toBeNull()
      expect(mockListRooms).toHaveBeenCalledWith(['world-nonexistent.dcl.eth'])
    })
  })

  describe('listRooms', () => {
    it('should return rooms from LiveKit API', async () => {
      mockListRooms.mockResolvedValue([
        { name: 'room-a', numParticipants: 2 },
        { name: 'room-b', numParticipants: 1 }
      ])

      const rooms = await livekitClient.listRooms()

      expect(rooms).toEqual([
        { name: 'room-a', numParticipants: 2 },
        { name: 'room-b', numParticipants: 1 }
      ])
      expect(mockListRooms).toHaveBeenCalledWith([])
    })

    it('should filter by room names when provided', async () => {
      mockListRooms.mockResolvedValue([{ name: 'room-a', numParticipants: 1 }])

      await livekitClient.listRooms(['room-a', 'room-b'])

      expect(mockListRooms).toHaveBeenCalledWith(['room-a', 'room-b'])
    })
  })

  describe('listRoomsWithParticipantCounts', () => {
    it('should return empty array when no rooms match', async () => {
      mockListRooms.mockResolvedValue([])

      const result = await livekitClient.listRoomsWithParticipantCounts()

      expect(result).toEqual([])
      expect(mockListRooms).toHaveBeenCalledTimes(1)
      expect(mockListRooms).toHaveBeenCalledWith([])
    })

    it('should filter by namePrefix and return name and numParticipants', async () => {
      mockListRooms
        .mockResolvedValueOnce([
          { name: 'world-room-a', numParticipants: 2 },
          { name: 'world-room-b', numParticipants: 1 },
          { name: 'other-room', numParticipants: 5 }
        ])
        .mockResolvedValueOnce([
          { name: 'world-room-a', numParticipants: 2 },
          { name: 'world-room-b', numParticipants: 1 }
        ])

      const result = await livekitClient.listRoomsWithParticipantCounts({
        namePrefix: 'world-'
      })

      expect(result).toEqual([
        { name: 'world-room-a', numParticipants: 2 },
        { name: 'world-room-b', numParticipants: 1 }
      ])
      expect(mockListRooms).toHaveBeenCalledTimes(2)
      expect(mockListRooms).toHaveBeenNthCalledWith(1, [])
      expect(mockListRooms).toHaveBeenNthCalledWith(2, ['world-room-a', 'world-room-b'])
    })

    it('should chunk room names and aggregate participant counts', async () => {
      const allRooms = Array.from({ length: 12 }, (_, i) => ({
        name: `world-room-${i + 1}`,
        numParticipants: 0
      }))
      const chunk1 = Array.from({ length: 10 }, (_, i) => ({
        name: `world-room-${i + 1}`,
        numParticipants: i + 1
      }))
      const chunk2 = [
        { name: 'world-room-11', numParticipants: 2 },
        { name: 'world-room-12', numParticipants: 1 }
      ]
      mockListRooms.mockResolvedValueOnce(allRooms).mockResolvedValueOnce(chunk1).mockResolvedValueOnce(chunk2)

      const result = await livekitClient.listRoomsWithParticipantCounts({
        namePrefix: 'world-',
        chunkSize: 10
      })

      expect(result).toHaveLength(12)
      expect(result.map((r) => r.numParticipants)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 1])
      expect(mockListRooms).toHaveBeenCalledTimes(3)
      expect(mockListRooms).toHaveBeenNthCalledWith(1, [])
      expect(mockListRooms).toHaveBeenNthCalledWith(
        2,
        Array.from({ length: 10 }, (_, i) => `world-room-${i + 1}`)
      )
      expect(mockListRooms).toHaveBeenNthCalledWith(3, ['world-room-11', 'world-room-12'])
    })
  })

  describe('createConnectionToken', () => {
    it('should return connection string with host and JWT', async () => {
      const grant = { roomJoin: true, room: 'world-myworld' }
      const token = await livekitClient.createConnectionToken('0xUser', grant)

      expect(token).toMatch(/^livekit:wss:\/\/livekit\.example\.com\?access_token=/)
    })
  })
})
