import { LivekitClient } from '../../src/types'

export function createMockLivekitClient(overrides: Partial<LivekitClient> = {}): LivekitClient {
  return {
    getRoom: jest.fn().mockResolvedValue(null),
    listRooms: jest.fn().mockResolvedValue([]),
    listRoomsWithParticipantCounts: jest.fn().mockResolvedValue([]),
    createConnectionToken: jest.fn().mockResolvedValue('livekit:wss://host?access_token=stub'),
    receiveWebhookEvent: jest.fn().mockResolvedValue({}),
    ...overrides
  }
}
