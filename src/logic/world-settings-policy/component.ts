import { IWorldSettingsPolicyComponent, LengthBounds, WORLD_CONTENT_RATINGS, WorldContentRating } from './types'

const TITLE_LENGTH: LengthBounds = { min: 3, max: 100 }
const DESCRIPTION_LENGTH: LengthBounds = { min: 3, max: 1000 }
const MAX_CATEGORIES = 20

// worlds.skybox_time is an INTEGER column
const PG_INT4_MIN = -2147483648
const PG_INT4_MAX = 2147483647

/**
 * Creates the component that decides what a world setting may contain.
 *
 * Pure: it holds the constraints and the coercions that apply them, and nothing else.
 *
 * @returns The world settings policy component
 */
export function createWorldSettingsPolicyComponent(): IWorldSettingsPolicyComponent {
  function isValidContentRating(value: unknown): value is WorldContentRating {
    return typeof value === 'string' && (WORLD_CONTENT_RATINGS as readonly string[]).includes(value)
  }

  function toStorableText(value: unknown, { min, max }: LengthBounds): string | null {
    if (typeof value !== 'string' || value.length < min || value.length > max) {
      return null
    }
    return value
  }

  function toStorableCategories(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CATEGORIES) {
      return null
    }
    return value.every((category) => typeof category === 'string') ? value : null
  }

  function toStorableSkyboxTime(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return null
    }
    return value >= PG_INT4_MIN && value <= PG_INT4_MAX ? value : null
  }

  return {
    contentRatings: WORLD_CONTENT_RATINGS,
    titleLength: TITLE_LENGTH,
    descriptionLength: DESCRIPTION_LENGTH,
    maxCategories: MAX_CATEGORIES,
    isValidContentRating,
    toStorableTitle: (value: unknown) => toStorableText(value, TITLE_LENGTH),
    toStorableDescription: (value: unknown) => toStorableText(value, DESCRIPTION_LENGTH),
    toStorableCategories,
    toStorableSkyboxTime
  }
}
