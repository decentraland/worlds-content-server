import type { Schema } from 'ajv'

const COORDINATE_PATTERN = '^-?\\d+,-?\\d+$'
const MAX_COORDINATES_PER_REQUEST = 500

export type GetWorldScenesRequestBody = {
  coordinates: string[]
}

export const getWorldScenesSchema: Schema = {
  type: 'object',
  properties: {
    coordinates: {
      type: 'array',
      items: {
        type: 'string',
        pattern: COORDINATE_PATTERN
      },
      minItems: 1,
      maxItems: MAX_COORDINATES_PER_REQUEST,
      uniqueItems: true
    }
  },
  required: ['coordinates'],
  additionalProperties: false
}
