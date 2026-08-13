/** Content ratings a world can carry, in ascending age order. */
export const WORLD_CONTENT_RATINGS = ['RP', 'E', 'T', 'A', 'R'] as const

export type WorldContentRating = (typeof WORLD_CONTENT_RATINGS)[number]

export type LengthBounds = {
  min: number
  max: number
}

export type NumberRange = {
  min: number
  max: number
}

/**
 * Owns what a world setting is allowed to contain.
 *
 * Both entry points feed through it — the settings endpoint, which rejects invalid input, and the
 * deploy path, which takes settings from unconstrained scene metadata and ignores what it cannot
 * store — so the two cannot drift on what counts as valid. Callers decide how to react to a rejected
 * value; the component only decides whether it is storable.
 */
export type IWorldSettingsPolicyComponent = {
  /** Supported content ratings, for callers that report them (e.g. a validation message). */
  readonly contentRatings: readonly WorldContentRating[]
  /** Accepted title length, for callers that report the bounds. */
  readonly titleLength: LengthBounds
  /** Accepted description length, for callers that report the bounds. */
  readonly descriptionLength: LengthBounds
  /** Largest number of categories a world may carry. */
  readonly maxCategories: number
  /** Range the skybox fixed time column can store, for callers that report the bounds. */
  readonly skyboxTimeRange: NumberRange

  /** Narrows an untrusted value to a supported content rating. */
  isValidContentRating(value: unknown): value is WorldContentRating

  /** Returns the title when it fits the accepted length, null otherwise. */
  toStorableTitle(value: unknown): string | null

  /** Returns the description when it fits the accepted length, null otherwise. */
  toStorableDescription(value: unknown): string | null

  /** Returns the categories when they are strings within the count limit, null otherwise. */
  toStorableCategories(value: unknown): string[] | null

  /**
   * Returns the skybox fixed time when the column can store it, null otherwise.
   *
   * `Scene` types it as an unconstrained number, so a fractional or oversized value would otherwise
   * fail a deployment with a raw PostgreSQL cast error.
   */
  toStorableSkyboxTime(value: unknown): number | null
}
