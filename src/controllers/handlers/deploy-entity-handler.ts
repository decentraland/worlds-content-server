import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@dcl/core-commons'
import { FormDataContext, readUploadedFile, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/http-commons'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import { calculateDeploymentSizeFromFileInfos } from '../../logic/validations/scene'
import { getConcurrency, mapWithConcurrency } from '../../logic/concurrency'

export const DEFAULT_CONTENT_FILE_INFO_CONCURRENCY = 64
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
 * Fetches content metadata through a continuous bounded worker pool.
 *
 * @param storage Content storage used for metadata checks.
 * @param hashes Content hashes referenced by the deployment.
 * @param concurrency Maximum number of concurrent checks delegated to storage.
 * @returns Storage metadata for every unique content hash.
 */
export async function getContentFileInfos(
  storage: Pick<IContentStorageComponent, 'fileInfo'>,
  hashes: string[],
  concurrency: number = DEFAULT_CONTENT_FILE_INFO_CONCURRENCY
): Promise<Map<string, FileInfo | undefined>> {
  const uniqueHashes = Array.from(new Set(hashes))
  const fileInfos = await mapWithConcurrency(uniqueHashes, concurrency, (hash) => storage.fileInfo(hash))
  return new Map(uniqueHashes.map((hash, index) => [hash, fileInfos[index]]))
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
    contentHashesInStorage: new Map<string, boolean>(),
    contentFileInfos: new Map<string, FileInfo | undefined>()
  }

  const preStorageValidationResult = await ctx.components.validator.validateBeforeStorage(deployment)
  if (!preStorageValidationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${preStorageValidationResult.errors.join(', ')}`)
  }

  const fileInfoConcurrency = await getConcurrency(
    ctx.components.config,
    'DEPLOYMENT_FILE_INFO_CONCURRENCY',
    DEFAULT_CONTENT_FILE_INFO_CONCURRENCY
  )
  const contentFileInfos = await getContentFileInfos(
    ctx.components.storage,
    entity.content!.map(($) => $.hash),
    fileInfoConcurrency
  )
  const contentHashesInStorage = new Map(Array.from(contentFileInfos, ([hash, info]) => [hash, info !== undefined]))

  const validationResult = await ctx.components.validator.validateAfterStorage({
    ...deployment,
    contentHashesInStorage,
    contentFileInfos
  })

  if (!validationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
  }

  // Store the entity
  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
  const deploymentSize = calculateDeploymentSizeFromFileInfos(entity, uploadedFiles, contentFileInfos)
  const message = await ctx.components.entityDeployer.deployEntity(
    baseUrl,
    entity,
    contentHashesInStorage,
    uploadedFiles,
    entityRaw,
    authChain,
    deploymentSize
  )

  return {
    status: 200,
    body: {
      creationTimestamp: Date.now(),
      ...message
    }
  }
}
