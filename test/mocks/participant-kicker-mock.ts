import { IParticipantKicker } from '../../src/logic/participant-kicker'

export function createMockParticipantKicker(
  overrides?: Partial<jest.Mocked<IParticipantKicker>>
): jest.Mocked<IParticipantKicker> {
  return {
    kickParticipant: jest.fn(),
    kickParticipants: jest.fn(),
    ...overrides
  }
}
