import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { FormDataContext } from '../../logic/multipart'
import { HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new Error('A string was expected')
  return val
}

export async function deployEntity(
  ctx: FormDataContext & HandlerContextWithPath<'config' | 'entityDeployer' | 'storage' | 'validator', '/entities'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = requireString(ctx.formData.fields.entityId.value)
  const authChain = extractAuthChain(ctx)

  const entityRaw = ctx.formData.files[entityId].value.toString()
  const entityMetadataJson = JSON.parse(entityRaw)

  const entity: Entity = {
    id: entityId, // this is not part of the published entity
    timestamp: Date.now(), // this is not part of the published entity
    ...entityMetadataJson
  }

  const uploadedFiles: Map<string, Uint8Array> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, ctx.formData.files[filesKey].value)
  }

  const contentHashesInStorage = await ctx.components.storage.existMultiple(
    Array.from(new Set(entity.content!.map(($) => $.hash)))
  )

  // run all validations about the deployment
  const validationResult = await ctx.components.validator.validate({
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage
  })
  if (!validationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
  }

  // Store the entity
  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
  const message = await ctx.components.entityDeployer.deployEntity(
    baseUrl,
    entity,
    contentHashesInStorage,
    uploadedFiles,
    entityRaw,
    authChain
  )

  return {
    status: 200,
    body: {
      creationTimestamp: Date.now(),
      ...message
    }
  }
}
