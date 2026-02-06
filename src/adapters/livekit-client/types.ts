export enum WebhookEventName {
  ParticipantJoined = 'participant_joined',
  ParticipantLeft = 'participant_left'
}

export type ParticipantEvent = WebhookEventName.ParticipantJoined | WebhookEventName.ParticipantLeft
