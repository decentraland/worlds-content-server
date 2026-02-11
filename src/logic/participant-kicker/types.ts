/**
 * Component that kicks participants from their rooms in batches.
 * Encapsulates batching and room iteration; used when handling access changes.
 */
export interface IParticipantKicker {
  kickParticipant(worldName: string, identity: string): Promise<void>
  kickParticipants(worldName: string, identities: string[]): Promise<void>
}
