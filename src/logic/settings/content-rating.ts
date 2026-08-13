/** Content ratings accepted for a world, in ascending age order. */
export const WORLD_CONTENT_RATINGS = ['RP', 'E', 'T', 'A', 'R'] as const

export type WorldContentRating = (typeof WORLD_CONTENT_RATINGS)[number]

/**
 * Narrows an untrusted value to a supported content rating.
 *
 * Scene metadata is deployer-controlled and `Scene` does not constrain `rating`, so deploy-derived
 * ratings must pass the same allow-list the settings endpoint enforces.
 */
export function isValidContentRating(value: unknown): value is WorldContentRating {
  return typeof value === 'string' && (WORLD_CONTENT_RATINGS as readonly string[]).includes(value)
}
