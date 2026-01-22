import type { Schema } from 'ajv'

export type ReprocessABWorldInput = {
  worldName: string
  entityIds?: string[]
}

export type ReprocessABInput = {
  worlds: ReprocessABWorldInput[]
}

// Pattern for world domain names (name.dcl.eth or name.eth)
const WORLD_NAME_PATTERN = '^[a-zA-Z0-9-]+\\.(dcl\\.eth|eth)$'

export const reprocessABSchema: Schema = {
  type: 'object',
  properties: {
    worlds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          worldName: { type: 'string', pattern: WORLD_NAME_PATTERN },
          entityIds: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['worldName'],
        additionalProperties: false
      },
      minItems: 1
    }
  },
  required: ['worlds'],
  additionalProperties: false
}
