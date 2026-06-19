import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@dcl/core-commons'
import { FormDataContext, readUploadedFile, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/http-commons'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new InvalidRequestError('A string was expected')
  return val
}

function parseEntityJson(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new InvalidRequestError('The entity file is not valid JSON.')
  }
}

export async function deployEntity(
  ctx: FormDataContext & HandlerContextWithPath<'config' | 'entityDeployer' | 'storage' | 'validator', '/entities'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = requireString(ctx.formData.fields.entityId?.value[0])
  const authChain = extractAuthChain(ctx)

  const entityFile = ctx.formData.files[entityId]
  if (!entityFile) {
    throw new InvalidRequestError(`Entity file "${entityId}" is missing from the request.`)
  }

  // The entity JSON is small, so it is safe to read fully into memory.
  const entityRaw = (await readUploadedFile(entityFile)).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)

  const entity: Entity = {
    id: entityId,
    ...entityMetadataJson
  }

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }

  const contentHashesInStorage = await ctx.components.storage.existMultiple(
    Array.from(new Set((entity.content || []).map(($) => $.hash)))
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
