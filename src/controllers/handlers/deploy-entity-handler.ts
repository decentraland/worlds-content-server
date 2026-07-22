import { Entity } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { IHttpServerComponent } from '@dcl/core-commons'
import { bufferToStream } from '@dcl/catalyst-storage'
import { hashV1 } from '@dcl/hashing'
import { FormDataContext, toDeploymentFile } from '../../logic/multipart'
import { DeploymentFile, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { InvalidRequestError } from '@dcl/http-commons'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import { calculateDeploymentSizeFromFileInfos } from '../../logic/validations/scene'
import { mapWithConcurrency } from '../../logic/concurrency'
import {
  DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError,
  isProcessingCancellationError
} from '../../logic/deployment-processing'

export { DEFAULT_CONTENT_FILE_INFO_CONCURRENCY } from '../../logic/deployment-processing'
export const MAX_ENTITY_FILE_SIZE_IN_BYTES = 5 * 1024 * 1024

type DeployEntityContext = FormDataContext &
  HandlerContextWithPath<
    | 'config'
    | 'deploymentProcessing'
    | 'entityDeployer'
    | 'logs'
    | 'partialDeployments'
    | 'pendingScenesManager'
    | 'storage'
    | 'validator',
    '/entities'
  >

// The entity file is the scene manifest (JSON): pointers, the content-hash list, and metadata — always
// small, independent of how large the content itself is. Cap it so it can be safely read fully into
// memory. This is important on a partial-resume request, where the entity is read back from storage and
// its size is NOT covered by the multipart in-flight-bytes budget (the resume body is tiny), so without
// a cap many concurrent resumes could each buffer a large stored entity and exhaust memory.
const MAX_ENTITY_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

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

// Buffers a stream but aborts as soon as it exceeds maxBytes. The storage metadata size can be null
// (unknown), so the size cap must be enforced while reading — buffering first and checking after would
// hold the whole blob in memory exactly in the case the cap exists for.
async function streamToBufferCapped(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new InvalidRequestError(`The stored entity file is too large (over ${maxBytes} bytes).`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
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

  // A `partial=true` field marks a staging request of a multi-request (partial) deployment: content may
  // be uploaded across several requests and the world only becomes live once all of it is present.
  const isPartial = ctx.formData.fields.partial?.value[0] === 'true'

  // Resolve the entity file. It must be uploaded on the first request; a later partial (resume) request
  // may omit it, in which case it is read back from storage where the first request stored it.
  let entityFile: DeploymentFile | undefined = ctx.formData.files[entityId]
    ? toDeploymentFile(ctx.formData.files[entityId])
    : undefined
  if (!entityFile && isPartial) {
    // Resume request: read the entity back from storage for an entity id the CLIENT supplied. Verify the
    // request is validly signed for that entity id BEFORE the read — the resume body is tiny so this read
    // is not covered by the multipart in-flight-bytes budget, and without this gate an unauthenticated
    // caller could make us retrieve and buffer up to MAX_ENTITY_FILE_SIZE_BYTES of storage per request
    // (memory + egress amplification). The full permission check still runs later in validateStaging;
    // this is only the cheap, local signature check (no provider), matching validateSignature.
    const signatureResult = await Authenticator.validateSignature(entityId, authChain, null, Date.now())
    if (!signatureResult.ok) {
      throw new InvalidRequestError(`Invalid auth chain: ${signatureResult.message}`)
    }
    const stored = await ctx.components.storage.retrieve(entityId)
    if (stored) {
      // streamToBufferCapped aborts past the cap while reading, so storage reporting size as null (the
      // metadata is not trustworthy for enforcement) can't let an oversized blob through.
      const buf = await streamToBufferCapped(await stored.asStream(), MAX_ENTITY_FILE_SIZE_BYTES)
      entityFile = {
        size: buf.length,
        getStream: () => bufferToStream(buf),
        getHash: () => hashV1(buf),
        asBuffer: async () => buf
      }
    }
  }
  if (!entityFile) {
    throw new InvalidRequestError(
      isPartial
        ? `The first partial request for an entity must include the entity file "${entityId}".`
        : `Entity file "${entityId}" is missing from the request.`
    )
  }
  // Cap the manifest size only on the partial path. Its purpose is to bound the storage read-back and
  // the first partial request's buffered manifest so a multi-request upload can't be wedged (resume caps
  // the same way); the vanilla single-request path is bounded below by MAX_ENTITY_FILE_SIZE_IN_BYTES.
  if (isPartial && entityFile.size > MAX_ENTITY_FILE_SIZE_BYTES) {
    throw new InvalidRequestError(`The entity file "${entityId}" is too large (${entityFile.size} bytes).`)
  }
  // The entity file is read fully into memory, so cap it on the vanilla path (the partial path applies
  // its own, larger cap above).
  if (!isPartial && entityFile.size > MAX_ENTITY_FILE_SIZE_IN_BYTES) {
    throw new InvalidRequestError(
      `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
    )
  }

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }
  // Ensure the entity file is in the map even when it came from storage (partial resume request).
  if (!uploadedFiles.has(entityId)) {
    uploadedFiles.set(entityId, entityFile)
  }

  // The entity JSON is small, so it is safe to buffer. Both the partial and vanilla paths need it, and
  // the hash reuses this same read. Read from the map entry (not the local `entityFile`) so the buffer is
  // memoized on the exact object validation later hashes. `id` is spread last so scene metadata cannot
  // override the id the client authenticated against.
  const entityRaw = (await uploadedFiles.get(entityId)!.asBuffer(signal)).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)
  const entity: Entity = { ...entityMetadataJson, id: entityId }

  if (isPartial) {
    const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
    const result = await ctx.components.partialDeployments.stage({
      baseUrl,
      entity,
      entityRaw,
      authChain,
      files: uploadedFiles
    })
    if (result.complete) {
      return {
        status: 200,
        body: {
          creationTimestamp: Date.now(),
          ...result.result
        }
      }
    }
    return { status: 202, body: { missing: result.missing ?? [] } }
  }

  // Vanilla (single-request) deployment — behaves exactly as before, plus TTL anchoring on and cleanup
  // of any pending upload that happens to exist for this entity.
  const pending = await ctx.components.pendingScenesManager.getByEntityId(entityId)

  const deployment = {
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage: new Map<string, boolean>(),
    pendingCreatedAt: pending?.createdAt,
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

  // If this entity had a pending (partial) upload, it is now fully deployed via the vanilla path, so
  // drop its staging row. Only when one exists (the common vanilla deploy has none), and best-effort:
  // the deployment already committed, so a cleanup failure must not turn a successful deploy into a
  // 5xx — the stale row would otherwise expire on its own via PENDING_DEPLOYMENT_TTL.
  if (pending) {
    try {
      await ctx.components.pendingScenesManager.deleteByEntityId(entityId)
    } catch (error) {
      ctx.components.logs
        .getLogger('deploy-entity')
        .warn(`Failed to delete pending scene after a successful deploy: ${error}`, { entityId })
    }
  }

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
    const abortedError =
      error instanceof DeploymentProcessingAbortedError
        ? error
        : abortContext.signal.reason instanceof DeploymentProcessingAbortedError
          ? abortContext.signal.reason
          : undefined
    // A genuine failure can race with a disconnect or the deadline; the cancellation response
    // below would otherwise be the only trace of it, since the global error handler never runs.
    if (abortContext.signal.aborted && !isProcessingCancellationError(error)) {
      ctx.components.logs.getLogger('deploy-entity-handler').error('Deployment failed while cancelled', {
        entityId: ctx.formData.fields.entityId?.value[0] ?? 'unknown',
        error: error instanceof Error ? error.message : String(error)
      })
    }
    if (abortedError) {
      // The transport is already gone in production. Returning a typed response keeps the expected
      // cancellation out of the global error handler's warning/500 path in direct or mocked callers.
      return {
        status: 499,
        body: {
          error: 'Client Closed Request',
          message: abortedError.message
        }
      }
    }
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
