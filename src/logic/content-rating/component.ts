import { IContentRatingComponent, WORLD_CONTENT_RATINGS, WorldContentRating } from './types'

/**
 * Creates the component that decides which content ratings a world may store.
 *
 * Pure: it owns the allow-list and nothing else, so the settings endpoint and the deploy path cannot
 * drift apart on what they accept.
 *
 * @returns The content rating component
 */
export function createContentRatingComponent(): IContentRatingComponent {
  function isValid(value: unknown): value is WorldContentRating {
    return typeof value === 'string' && (WORLD_CONTENT_RATINGS as readonly string[]).includes(value)
  }

  return {
    supported: WORLD_CONTENT_RATINGS,
    isValid
  }
}
