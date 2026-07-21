import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@dcl/core-commons'
import { FormDataContext, readUploadedFile, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/http-commons'
import { IContentStorageComponent } from '@dcl/catalyst-storage'

export const DEFAULT_CONTENT_AVAILABILITY_BATCH_SIZE = 64
export const MAX_ENTITY_FILE_SIZE_IN_BYTES = 5 * 1024 * 1024

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

/**
 * Checks content availability in bounded sequential batches. The underlying storage component
 * performs each call with `Promise.all`, so bounding each batch prevents a large valid deployment
 * from opening thousands of simultaneous storage requests.
 *
 * @param storage Content storage used for existence checks.
 * @param hashes Content hashes referenced by the deployment.
 * @param batchSize Maximum number of concurrent checks delegated to storage.
 * @returns Availability for every unique content hash.
 */
export async function getContentAvailability(
  storage: Pick<IContentStorageComponent, 'existMultiple'>,
  hashes: string[],
  batchSize: number = DEFAULT_CONTENT_AVAILABILITY_BATCH_SIZE
): Promise<Map<string, boolean>> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Content availability batch size must be a positive safe integer, got ${batchSize}`)
  }

  const uniqueHashes = Array.from(new Set(hashes))
  const availability = new Map<string, boolean>()
  for (let offset = 0; offset < uniqueHashes.length; offset += batchSize) {
    const batchAvailability = await storage.existMultiple(uniqueHashes.slice(offset, offset + batchSize))
    for (const [hash, exists] of batchAvailability) {
      availability.set(hash, exists)
    }
  }
  return availability
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
  if (entityFile.size > MAX_ENTITY_FILE_SIZE_IN_BYTES) {
    throw new InvalidRequestError(
      `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
    )
  }

  // The entity JSON is small, so it is safe to read fully into memory.
  const entityRaw = (await readUploadedFile(entityFile)).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)

  const entity: Entity = { ...entityMetadataJson, id: entityId }

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }

  const deployment = {
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage: new Map<string, boolean>()
  }

  const preStorageValidationResult = await ctx.components.validator.validateBeforeStorage(deployment)
  if (!preStorageValidationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${preStorageValidationResult.errors.join(', ')}`)
  }

  const contentHashesInStorage = await getContentAvailability(
    ctx.components.storage,
    entity.content!.map(($) => $.hash)
  )

  const validationResult = await ctx.components.validator.validateAfterStorage({
    ...deployment,
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
