import { Entity } from '@dcl/schemas'
import { FormDataContext } from './multipart'
import { extractAuthChain } from './extract-auth-chain'
import { requireString } from '../controllers/handlers/deploy-entity-handler'

export function extractFromContext(ctx: FormDataContext) {
  const { formData } = ctx

  const entityId = requireString(formData.fields.entityId.value)
  const authChain = extractAuthChain(ctx)

  const entityRaw = formData.files[entityId].value
  const entityMetadataJson = JSON.parse(entityRaw.toString())

  const entity: Entity = {
    id: entityId, // this is not part of the published entity
    timestamp: Date.now(), // this is not part of the published entity
    ...entityMetadataJson
  }

  const uploadedFiles: Map<string, Uint8Array> = new Map()
  for (const filesKey in formData.files) {
    uploadedFiles.set(filesKey, formData.files[filesKey].value)
  }

  return {
    entity,
    entityRaw,
    authChain,
    uploadedFiles
  }
}
