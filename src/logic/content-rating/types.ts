/** Content ratings a world can carry, in ascending age order. */
export const WORLD_CONTENT_RATINGS = ['RP', 'E', 'T', 'A', 'R'] as const

export type WorldContentRating = (typeof WORLD_CONTENT_RATINGS)[number]

export type IContentRatingComponent = {
  /** The supported ratings, for callers that need to report them (e.g. a validation message). */
  readonly supported: readonly WorldContentRating[]

  /**
   * Narrows an untrusted value to a supported content rating.
   *
   * Both the settings endpoint and deploy-derived scene metadata are caller-controlled, so both go
   * through this instead of each keeping its own allow-list.
   *
   * @param value - Untrusted candidate rating
   * @returns true when the value is one of the supported ratings
   */
  isValid(value: unknown): value is WorldContentRating
}
