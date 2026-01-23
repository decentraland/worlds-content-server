import type { JSONSchema } from '@dcl/schemas'

const COORDINATE_PATTERN = '^-?\\d+,-?\\d+$'

export type GetWorldScenesRequestBody = {
  coordinates: string[]
}

export const getWorldScenesSchema: JSONSchema<GetWorldScenesRequestBody> = {
  type: 'object',
  properties: {
    coordinates: {
      type: 'array',
      items: { type: 'string', pattern: COORDINATE_PATTERN }
    }
  },
  required: ['coordinates'],
  additionalProperties: false
}
