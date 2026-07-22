import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@dcl/core-commons'
import { FormDataContext, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/http-commons'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import { calculateDeploymentSizeFromFileInfos } from '../../logic/validations/scene'
import { mapWithConcurrency } from '../../logic/concurrency'
import {
  DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  DeploymentProcessingTimeoutError
} from '../../logic/deployment-processing'

export { DEFAULT_CONTENT_FILE_INFO_CONCURRENCY } from '../../logic/deployment-processing'
export const MAX_ENTITY_FILE_SIZE_IN_BYTES = 5 * 1024 * 1024

type DeployEntityContext = FormDataContext &
  HandlerContextWithPath<'config' | 'deploymentProcessing' | 'entityDeployer' | 'storage' | 'validator', '/entities'>

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
 * @param signal Optional deadline or request-disconnect signal.
 * @param trackWorker Optional worker telemetry wrapper.
 * @returns Storage metadata for every unique content hash.
 * @throws The cancellation reason without waiting for active metadata calls, which own no request files.
 */
export async function getContentFileInfos(
  storage: Pick<IContentStorageComponent, 'fileInfo'>,
  hashes: string[],
  concurrency: number = DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  signal?: AbortSignal,
  trackWorker?: (operation: () => Promise<FileInfo | undefined>) => Promise<FileInfo | undefined>
): Promise<Map<string, FileInfo | undefined>> {
  const uniqueHashes = Array.from(new Set(hashes))
  const fileInfos = await mapWithConcurrency(
    uniqueHashes,
    concurrency,
    (hash) => (trackWorker ? trackWorker(() => storage.fileInfo(hash)) : storage.fileInfo(hash)),
    { signal, waitForActiveOnAbort: false }
  )
  return new Map(uniqueHashes.map((hash, index) => [hash, fileInfos[index]]))
}

async function deployEntityWithSignal(
  ctx: DeployEntityContext,
  signal: AbortSignal,
  deadlineAt: number
): Promise<IHttpServerComponent.IResponse> {
  const { deploymentProcessing } = ctx.components
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

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }

  // The entity JSON is small, so it is safe to buffer. Its hash reuses this same read.
  const entityRaw = (await uploadedFiles.get(entityId)!.asBuffer(signal)).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)
  const entity: Entity = { ...entityMetadataJson, id: entityId }

  const deployment = {
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage: new Map<string, boolean>(),
    signal
  }

  const preStorageValidationResult = await ctx.components.validator.validateBeforeStorage(deployment)
  if (!preStorageValidationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${preStorageValidationResult.errors.join(', ')}`)
  }

  signal.throwIfAborted()
  const contentHashes = entity.content!.map(($) => $.hash)
  const contentFileInfos = await deploymentProcessing.trackStage('metadata', new Set(contentHashes).size, () =>
    getContentFileInfos(
      ctx.components.storage,
      contentHashes,
      deploymentProcessing.fileInfoConcurrency,
      signal,
      (operation) => deploymentProcessing.trackWorker('metadata', operation)
    )
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
  signal.throwIfAborted()
  const message = await ctx.components.entityDeployer.deployEntity(
    baseUrl,
    entity,
    contentHashesInStorage,
    uploadedFiles,
    entityRaw,
    authChain,
    deploymentSize,
    signal,
    deadlineAt
  )

  return {
    status: 200,
    body: {
      creationTimestamp: Date.now(),
      ...message
    }
  }
}

export async function deployEntity(ctx: DeployEntityContext): Promise<IHttpServerComponent.IResponse> {
  const abortContext = ctx.components.deploymentProcessing.createAbortContext(ctx.request?.signal)
  try {
    return await ctx.components.deploymentProcessing.trackStage('total', Object.keys(ctx.formData.files).length, () =>
      deployEntityWithSignal(ctx, abortContext.signal, abortContext.deadlineAt)
    )
  } catch (error) {
    const timeoutError =
      error instanceof DeploymentProcessingTimeoutError
        ? error
        : abortContext.signal.reason instanceof DeploymentProcessingTimeoutError
          ? abortContext.signal.reason
          : undefined
    if (timeoutError) {
      return {
        status: 408,
        body: {
          error: 'Request Timeout',
          message: timeoutError.message
        }
      }
    }
    throw error
  } finally {
    abortContext.dispose()
  }
}
