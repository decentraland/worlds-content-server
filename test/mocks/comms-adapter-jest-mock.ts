import { ICommsAdapter } from '../../src/types'

export const createMockCommsAdapter = (overrides?: Partial<jest.Mocked<ICommsAdapter>>): jest.Mocked<ICommsAdapter> => {
  return {
    getWorldRoomConnectionString: jest.fn(),
    getSceneRoomConnectionString: jest.fn(),
    getWorldRoomParticipantCount: jest.fn(),
    getWorldSceneRoomsParticipantCount: jest.fn(),
    status: jest.fn(),
    removeParticipant: jest.fn(),
    ...overrides
  }
}
