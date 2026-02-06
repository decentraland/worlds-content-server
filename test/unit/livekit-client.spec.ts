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

  describe('createConnectionToken', () => {
    it('should return connection string with host and JWT', async () => {
      const grant = { roomJoin: true, room: 'world-myworld' }
      const token = await livekitClient.createConnectionToken('0xUser', grant)

      expect(token).toMatch(/^livekit:wss:\/\/livekit\.example\.com\?access_token=/)
    })
  })
})
