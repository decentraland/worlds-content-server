import { Entity } from '@dcl/schemas'
import { IHttpServerComponent } from '@dcl/core-commons'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { FormDataContext, toDeploymentFile } from '../../logic/multipart'
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
  ctx: FormDataContext &
    HandlerContextWithPath<
      'config' | 'entityDeployer' | 'logs' | 'partialDeployments' | 'pendingScenesManager' | 'storage' | 'validator',
      '/entities'
    >
): Promise<IHttpServerComponent.IResponse> {
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
    const stored = await ctx.components.storage.retrieve(entityId)
    if (stored) {
      const buf = await streamToBuffer(await stored.asStream())
      entityFile = { size: buf.length, getStream: () => bufferToStream(buf), asBuffer: async () => buf }
    }
  }
  if (!entityFile) {
    throw new InvalidRequestError(
      isPartial
        ? `The first partial request for an entity must include the entity file "${entityId}".`
        : `Entity file "${entityId}" is missing from the request.`
    )
  }

  // The entity JSON is small, so it is safe to read fully into memory.
  const entityRaw = (await entityFile.asBuffer()).toString()
  const entityMetadataJson = parseEntityJson(entityRaw)

  const entity: Entity = {
    id: entityId,
    ...entityMetadataJson
  }

  const uploadedFiles: Map<string, DeploymentFile> = new Map()
  for (const filesKey in ctx.formData.files) {
    uploadedFiles.set(filesKey, toDeploymentFile(ctx.formData.files[filesKey]))
  }
  // Ensure the entity file is in the map even when it came from storage (partial resume request).
  if (!uploadedFiles.has(entityId)) {
    uploadedFiles.set(entityId, entityFile)
  }

  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`

  if (isPartial) {
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

  const contentHashesInStorage = await ctx.components.storage.existMultiple(
    Array.from(new Set((entity.content || []).map(($) => $.hash)))
  )

  // run all validations about the deployment
  const validationResult = await ctx.components.validator.validate({
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage,
    pendingCreatedAt: pending?.createdAt
  })

  if (!validationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
  }

  // Store the entity
  const message = await ctx.components.entityDeployer.deployEntity(
    baseUrl,
    entity,
    contentHashesInStorage,
    uploadedFiles,
    entityRaw,
    authChain
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
