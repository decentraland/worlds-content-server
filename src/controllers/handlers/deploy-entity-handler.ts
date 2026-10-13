import { AuthChain, Entity } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { IHttpServerComponent } from '@dcl/core-commons'
import { bufferToStream } from '@dcl/catalyst-storage'
import { hashV1 } from '@dcl/hashing'
import { FormDataContext, toDeploymentFile } from '../../logic/form-data'
import { DeploymentFile, DeploymentToValidate, HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'
import { validateAuthChain, validateSignature, validateSigner } from '../../logic/validations/common'
import { buildSceneDeploymentMessage, requireString } from '../../logic/utils'
import { InvalidRequestError } from '@dcl/http-commons'
import { Readable } from 'stream'
import { mapWithConcurrency, raceWithSignal } from '../../logic/concurrency'
import { getRequestArrival, RequestArrivalContext } from '../request-arrival'
import { PartialUploadQuotaExceededError } from '../../logic/partial-upload-admission'
import { StagingPrevalidation } from '../../logic/scene-deployments'
import {
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError,
  isProcessingCancellationError
} from '../../logic/deployment-processing'
import { toDeploymentErrorResponse } from '../upload-error-handler'

// The entity file is the scene manifest (JSON), small whatever the content size, so it is buffered
// in full. Capped (5 MiB) because a partial resume reads it back from storage outside the multipart
// in-flight-bytes budget, so concurrent resumes could otherwise each buffer a large stored entity.
export const MAX_ENTITY_FILE_SIZE_IN_BYTES = 5 * 1024 * 1024

// The arrival stamp is optional: only routes behind stampRequestArrival carry it.
type DeployEntityContext = FormDataContext &
  Partial<RequestArrivalContext> &
  HandlerContextWithPath<
    | 'contentLocks'
    | 'config'
    | 'deploymentProcessing'
    | 'logs'
    | 'metrics'
    | 'sceneDeployments'
    | 'partialUploadAdmission'
    | 'storage',
    '/entities'
  >

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
async function streamToBufferCapped(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of Readable.from(stream, { signal })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new InvalidRequestError(`The stored entity file is too large (over ${maxBytes} bytes).`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

type AuthenticatedRequest = { entityId: string; authChain: AuthChain; isPartial: boolean }

/**
 * Cheap request checks that must run before any content lock is taken, so a request that can't be
 * authenticated never holds a lock connection. The signature check is the same local one the
 * deployment validator runs.
 */
async function authenticateRequest(ctx: DeployEntityContext): Promise<AuthenticatedRequest> {
  // A `partial=true` field marks a staging request of a multi-request (partial) deployment: content may
  // be uploaded across several requests and the world only becomes live once all of it is present.
  const isPartial = ctx.formData.fields.partial?.value[0] === 'true'
  // Clients may also declare a batch with `?partial=true`; it must agree with the form, as on Catalyst.
  if (!isPartial && ctx.url.searchParams.get('partial') === 'true') {
    throw new InvalidRequestError("The 'partial=true' query parameter requires the 'partial=true' form field")
  }
  const entityId = requireString(ctx.formData.fields.entityId?.value[0])
  const authChain = extractAuthChain(ctx)
  if (isPartial) {
    if (!AuthChain.validate(authChain)) throw new InvalidRequestError('Invalid auth chain.')
    const signature = await Authenticator.validateSignature(entityId, authChain, null, Date.now())
    if (!signature.ok) throw new InvalidRequestError(`Invalid auth chain: ${signature.message}`)
    return { entityId, authChain, isPartial }
  }
  const identity = { entity: { id: entityId }, authChain } as DeploymentToValidate
  for (const validation of [validateAuthChain, validateSigner, validateSignature]) {
    const result = await validation(identity)
    if (!result.ok()) throw new InvalidRequestError(`Deployment failed: ${result.errors.join(', ')}`)
  }
  return { entityId, authChain, isPartial }
}

type ParsedEntity = { entity: Entity; entityFile: Uint8Array }

/** Request work done before the content lock: only the request's own temp files and database reads. */
type PreparedDeployment =
  | {
      kind: 'partial'
      uploadedFiles: Map<string, DeploymentFile>
      /** Unset for a resume batch that omits the entity file. */
      parsed?: ParsedEntity
      /** Set when the batch passed its staging validation. */
      prevalidation?: StagingPrevalidation
    }
  | {
      kind: 'regular'
      uploadedFiles: Map<string, DeploymentFile>
      parsed: ParsedEntity
      /** Passed its pre-storage validation. */
      deployment: DeploymentToValidate
    }

async function getBaseUrl(ctx: DeployEntityContext): Promise<string> {
  return (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
}

// Lenient like the catalysts (a BOM is skipped, invalid bytes are replaced); storage keeps the uploaded bytes.
const entityFileDecoder = new TextDecoder()

// Reads the entity JSON, small whatever the content size, from the object validation later hashes so the
// buffer is memoized on it. `id` is spread last so scene metadata cannot override the authenticated id.
async function readEntity(file: DeploymentFile, entityId: string, signal: AbortSignal): Promise<ParsedEntity> {
  // The entity file is read fully into memory on both paths.
  if (file.size > MAX_ENTITY_FILE_SIZE_IN_BYTES) {
    throw new InvalidRequestError(
      `The entity file is too large. The maximum allowed size is ${MAX_ENTITY_FILE_SIZE_IN_BYTES} bytes.`
    )
  }
  const entityFile = await file.asBuffer(signal)
  return { entity: { ...parseEntityJson(entityFileDecoder.decode(entityFile)), id: entityId }, entityFile }
}

/** Answers a partial batch of an entity that is already published, from receipts or the live scene. */
async function findPartialReplay(
  ctx: DeployEntityContext,
  request: AuthenticatedRequest,
  signal: AbortSignal
): Promise<IHttpServerComponent.IResponse | undefined> {
  return ctx.components.deploymentProcessing.trackStage('lookup', 1, () => lookUpPartialReplay(ctx, request, signal))
}

async function lookUpPartialReplay(
  ctx: DeployEntityContext,
  { entityId, authChain }: AuthenticatedRequest,
  signal: AbortSignal
): Promise<IHttpServerComponent.IResponse | undefined> {
  const baseUrl = await getBaseUrl(ctx)
  // The receipt keeps answering the finalizer after an undeploy or replacement.
  const completed = await ctx.components.partialUploadAdmission.getCompleted(entityId, authChain[0].payload, signal)
  if (completed) {
    return {
      status: 200,
      body: {
        creationTimestamp: completed.creationTimestamp,
        message: buildSceneDeploymentMessage(baseUrl, completed.worldName, completed.parcels)
      }
    }
  }
  // A live entity is never restaged: any signer's batch, with or without the manifest, gets its publication.
  const published = await ctx.components.sceneDeployments.findPublication(baseUrl, entityId, signal)
  if (published) {
    return { status: 200, body: { creationTimestamp: published.creationTimestamp, ...published.result } }
  }
  return undefined
}

/**
 * Validates what needs neither storage nor the content lock, so an invalid or unauthorized request never
 * holds a lock connection while its files are hashed or its permission is checked.
 */
async function prepareDeployment(
  ctx: DeployEntityContext,
  request: AuthenticatedRequest,
  signal: AbortSignal
): Promise<{ response: IHttpServerComponent.IResponse } | { prepared: PreparedDeployment }> {
  const { entityId, authChain, isPartial } = request
  const { deploymentProcessing, sceneDeployments, partialUploadAdmission } = ctx.components
  signal.throwIfAborted()
  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }
  const uploadedEntity = uploadedFiles.get(entityId)

  if (isPartial) {
    // Read before the replay checks: a publication in between is then answered as a replay instead of
    // validating a long upload's entity against now. Staging re-reads it under the lock.
    const pending = await deploymentProcessing.trackStage('lookup', 1, () =>
      partialUploadAdmission.getByEntityId(entityId, signal)
    )
    const replay = await findPartialReplay(ctx, request, signal)
    if (replay) return { response: replay }
    if (!uploadedEntity) {
      // The manifest is read back from storage under the lock; only its own signer's resume is hashed now.
      if (pending?.deployer === authChain[0].payload.toLowerCase()) {
        await deploymentProcessing.trackStage('hash', uploadedFiles.size, () =>
          mapWithConcurrency(
            Array.from(uploadedFiles.values()),
            deploymentProcessing.hashConcurrency,
            (file) => deploymentProcessing.trackWorker('hash', () => file.getHash(signal)),
            { signal }
          )
        )
      }
      return { prepared: { kind: 'partial', uploadedFiles } }
    }
    const parsed = await readEntity(uploadedEntity, entityId, signal)
    const prevalidation = await sceneDeployments.prevalidate(
      { entity: parsed.entity, authChain, files: uploadedFiles, signal, requestArrivedAt: getRequestArrival(ctx) },
      pending
    )
    return { prepared: { kind: 'partial', uploadedFiles, parsed, prevalidation } }
  }

  if (!uploadedEntity) throw new InvalidRequestError(`Entity file "${entityId}" is missing from the request.`)
  const parsed = await readEntity(uploadedEntity, entityId, signal)
  const deployment = await sceneDeployments.prevalidateDeployment({
    entity: parsed.entity,
    authChain,
    files: uploadedFiles,
    signal
  })
  return { prepared: { kind: 'regular', uploadedFiles, parsed, deployment } }
}

/** Reads a resume batch's manifest back from storage when its own signer holds the pending upload. */
async function readStoredManifest(
  ctx: DeployEntityContext,
  { entityId, authChain }: AuthenticatedRequest,
  signal: AbortSignal
): Promise<DeploymentFile | undefined> {
  // Resume request: read the entity back from storage for an entity id the CLIENT supplied. The resume
  // body is tiny, so this read is NOT covered by the multipart in-flight-bytes budget — it must be
  // gated before any storage I/O or an attacker could turn cheap requests into concurrent
  // MAX_ENTITY_FILE_SIZE_IN_BYTES reads + buffers (memory + egress amplification). Two gates, cheap first:
  // 1. The local signature check (authenticateRequest): the request is validly signed for this entity
  //    id. Alone this is NOT sufficient — any keypair can sign any entity id — so also:
  // 2. A live pending upload for this entity, created by this same signer, must exist. Creating a
  //    pending row required passing the full staging validation (including the deployment-permission
  //    check) and rows are capped per deployer, so read-backs are bounded to in-flight uploads by
  //    their own permission-validated deployer. Any other signer (or an expired upload) must re-send
  //    the entity file instead, which restarts/joins the upload through the fully-validated path.
  const pendingForResume = await ctx.components.partialUploadAdmission.getByEntityId(entityId, signal)
  if (!pendingForResume || pendingForResume.deployer !== authChain[0].payload.toLowerCase()) return undefined
  const stored = await raceWithSignal(ctx.components.storage.retrieve(entityId), signal)
  if (!stored) return undefined
  // streamToBufferCapped aborts past the cap while reading, so storage reporting size as null (the
  // metadata is not trustworthy for enforcement) can't let an oversized blob through.
  const buf = await streamToBufferCapped(
    await raceWithSignal(stored.asStream(), signal),
    MAX_ENTITY_FILE_SIZE_IN_BYTES,
    signal
  )
  return {
    size: buf.length,
    getStream: () => bufferToStream(buf),
    getHash: () => hashV1(buf),
    asBuffer: async () => buf
  }
}

async function deployEntityWithSignal(
  ctx: DeployEntityContext,
  request: AuthenticatedRequest,
  prepared: PreparedDeployment,
  signal: AbortSignal,
  deadlineAt: number
): Promise<IHttpServerComponent.IResponse> {
  const { entityId, authChain } = request
  const { uploadedFiles } = prepared
  if (prepared.kind === 'partial') {
    // Re-checked under the per-entity lock: a concurrent batch may have published it meanwhile.
    const replay = await findPartialReplay(ctx, request, signal)
    if (replay) return replay

    let parsed = prepared.parsed
    // Set when a resume batch omits the manifest: it is validated but never charged or stored again.
    let manifest: DeploymentFile | undefined
    if (!parsed) {
      manifest = await ctx.components.deploymentProcessing.trackStage('lookup', 1, () =>
        readStoredManifest(ctx, request, signal)
      )
      // When either gate fails, the manifest stays unset and the error below tells the client to re-send
      // the entity file — the correct recovery in every one of those cases.
      if (!manifest) {
        throw new InvalidRequestError(
          `The first partial request for an entity must include the entity file "${entityId}".`
        )
      }
      parsed = await readEntity(manifest, entityId, signal)
    }

    // The abort context bounds each staging request like a vanilla deploy: a disconnect or the
    // processing deadline cancels validation/hashing/storing (the pending row survives, so the client
    // resumes), and bounds the deploy transaction when this request finalizes.
    const result = await ctx.components.sceneDeployments.stage({
      baseUrl: await getBaseUrl(ctx),
      ...parsed,
      authChain,
      files: uploadedFiles,
      manifest,
      signal,
      deadlineAt,
      requestArrivedAt: getRequestArrival(ctx),
      prevalidation: prepared.prevalidation
    })
    if (result.complete) {
      return {
        status: 200,
        body: {
          creationTimestamp: result.creationTimestamp,
          ...result.result
        }
      }
    }
    return { status: 202, body: { missing: result.missing ?? [] } }
  }

  // Vanilla (single-request) deployment, validated before the lock up to its storage-backed checks.
  const result = await ctx.components.sceneDeployments.deploy({
    baseUrl: await getBaseUrl(ctx),
    entityFile: prepared.parsed.entityFile,
    deployment: prepared.deployment,
    signal,
    deadlineAt
  })
  return { status: 200, body: result }
}

/** Runs the operation under the shared content lock, timing the wait for it as the `lock` stage. */
async function withTimedReadLock<T>(
  ctx: DeployEntityContext,
  entityId: string,
  signal: AbortSignal,
  operation: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  let acquired: () => void = () => undefined
  let failed: (error: unknown) => void = () => undefined
  const lockAcquired = new Promise<void>((resolve, reject) => {
    acquired = resolve
    failed = reject
  })
  ctx.components.deploymentProcessing.trackStage('lock', 1, () => lockAcquired).catch(() => undefined)
  try {
    return await ctx.components.contentLocks.withRead(
      (lockSignal) => {
        acquired()
        return operation(lockSignal)
      },
      signal,
      entityId
    )
  } catch (error) {
    failed(error)
    throw error
  } finally {
    // No-op once settled; ends the stage even if the lock never ran the operation.
    acquired()
  }
}

const PARTIAL_OUTCOME_BY_STATUS: Record<number, string> = {
  200: 'finalized',
  202: 'accepted',
  408: 'timeout',
  429: 'throttled',
  499: 'aborted'
}

export async function deployEntity(ctx: DeployEntityContext): Promise<IHttpServerComponent.IResponse> {
  const { deploymentProcessing, metrics } = ctx.components
  if (ctx.formData.fields.partial?.value[0] !== 'true') {
    return deploymentProcessing.runInMode('regular', () => handleDeployment(ctx))
  }
  try {
    const response = await deploymentProcessing.runInMode('partial', () => handleDeployment(ctx))
    const status = response.status ?? 200
    metrics.increment('partial_upload_requests', {
      outcome: PARTIAL_OUTCOME_BY_STATUS[status] ?? (status < 500 ? 'validation_error' : 'error')
    })
    return response
  } catch (error) {
    metrics.increment('partial_upload_requests', {
      outcome: error instanceof InvalidRequestError ? 'validation_error' : 'error'
    })
    throw error
  }
}

async function handleDeployment(ctx: DeployEntityContext): Promise<IHttpServerComponent.IResponse> {
  const abortContext = ctx.components.deploymentProcessing.createAbortContext(ctx.request?.signal)
  try {
    const request = await authenticateRequest(ctx)
    return await ctx.components.deploymentProcessing.trackStage(
      'total',
      Object.keys(ctx.formData.files).length,
      async () => {
        const preparation = await prepareDeployment(ctx, request, abortContext.signal)
        if ('response' in preparation) return preparation.response
        return withTimedReadLock(ctx, request.entityId, abortContext.signal, (signal) =>
          deployEntityWithSignal(
            ctx,
            request,
            preparation.prepared,
            signal ?? abortContext.signal,
            abortContext.deadlineAt
          )
        )
      }
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
    const timeoutError =
      error instanceof DeploymentProcessingTimeoutError
        ? error
        : abortContext.signal.reason instanceof DeploymentProcessingTimeoutError
          ? abortContext.signal.reason
          : undefined
    const outcome = abortedError ?? timeoutError ?? error
    if (outcome instanceof PartialUploadQuotaExceededError) {
      ctx.components.metrics.increment('partial_upload_throttled', { reason: outcome.quota })
    }
    const response = toDeploymentErrorResponse(outcome)
    if (response) return response
    throw error
  } finally {
    abortContext.dispose()
  }
}
