import type { Schema } from 'ajv'

const COORDINATE_PATTERN = '^-?\\d+,-?\\d+$'

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
      }
    }
  },
  required: ['coordinates'],
  additionalProperties: false
}
