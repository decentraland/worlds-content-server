import type { JSONSchemaType } from 'ajv'

export type WorldSettingsInput = {
  spawn_coordinates: string
}

export const worldSettingsSchema: JSONSchemaType<WorldSettingsInput> = {
  type: 'object',
  properties: {
    spawn_coordinates: { type: 'string', pattern: '^\\d+,\\d+$' }
  },
  required: ['spawn_coordinates'],
  additionalProperties: false
}
