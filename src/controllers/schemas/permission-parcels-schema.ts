import type { Schema } from 'ajv'

export type PermissionParcelsInput = {
  parcels: string[]
}

const MAX_PARCELS_PER_REQUEST = 500

export const permissionParcelsSchema: Schema = {
  type: 'object',
  properties: {
    parcels: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^-?\\d+,-?\\d+$'
      },
      minItems: 1,
      maxItems: MAX_PARCELS_PER_REQUEST
    }
  },
  required: ['parcels'],
  additionalProperties: false
}
