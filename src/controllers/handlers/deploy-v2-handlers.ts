import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/http-commons'
import { FormDataContext } from '../../logic/multipart'
import { HandlerContextWithPath } from '../../types'
import { extractAuthChain } from '../../logic/extract-auth-chain'

const TOKEN_HEADER = 'x-deployment-token'

/** Init: dispatched here by deployEntity when it sees Upload-Incomplete: ?1 */
export async function initPartialDeployment(
  ctx: FormDataContext &
    HandlerContextWithPath<'partialDeploymentManager', '/entities'>
): Promise<IHttpServerComponent.IResponse> {
  const entityIdRaw = ctx.formData.fields.entityId?.value[0]
  if (typeof entityIdRaw !== 'string') {
    throw new InvalidRequestError('entityId is required')
  }
  const entityId = entityIdRaw
  const authChain = extractAuthChain(ctx)

  const entityFile = ctx.formData.files[entityId]
  if (!entityFile) {
    throw new InvalidRequestError(`Entity file ${entityId} missing in init multipart`)
  }
  const entityRaw = entityFile.value as Buffer

  const manifestRaw = ctx.formData.fields.fileSizesManifest?.value[0]
  if (typeof manifestRaw !== 'string') {
    throw new InvalidRequestError('fileSizesManifest field is required')
  }
  let manifest: Record<string, number>
  try {
    manifest = JSON.parse(manifestRaw)
  } catch {
    throw new InvalidRequestError('fileSizesManifest is not valid JSON')
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new InvalidRequestError('fileSizesManifest must be a JSON object')
  }

  const ownerAddress = (authChain[0]?.payload || '').toLowerCase()
  if (!ownerAddress) throw new InvalidRequestError('authChain payload missing')

  const result = await ctx.components.partialDeploymentManager.init({
    entityId,
    entityRaw,
    authChain,
    ownerAddress,
    manifest
  })

  return {
    status: 202,
    body: result
  }
}

/** POST /entities/:entityId/files/:fileHash */
export async function addFileToPartialDeployment(
  ctx: HandlerContextWithPath<'partialDeploymentManager', '/entities/:entityId/files/:fileHash'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = ctx.params.entityId
  const fileHash = ctx.params.fileHash
  const token = ctx.request.headers.get(TOKEN_HEADER)
  if (!token) throw new InvalidRequestError(`Missing ${TOKEN_HEADER} header`)

  const buffer = await ctx.request.buffer()
  await ctx.components.partialDeploymentManager.addFile(entityId, fileHash, token, buffer)
  return { status: 204, body: '' }
}

/** POST /entities/:entityId */
export async function finalizePartialDeployment(
  ctx: HandlerContextWithPath<'config' | 'partialDeploymentManager', '/entities/:entityId'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = ctx.params.entityId
  const token = ctx.request.headers.get(TOKEN_HEADER)
  if (!token) throw new InvalidRequestError(`Missing ${TOKEN_HEADER} header`)

  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`
  const result = await ctx.components.partialDeploymentManager.complete(baseUrl, entityId, token)
  return {
    status: 200,
    body: { creationTimestamp: Date.now(), ...result }
  }
}

/** GET /entities/:entityId/status */
export async function getPartialDeploymentStatus(
  ctx: HandlerContextWithPath<'partialDeploymentManager', '/entities/:entityId/status'>
): Promise<IHttpServerComponent.IResponse> {
  const status = await ctx.components.partialDeploymentManager.status(ctx.params.entityId)
  if (!status) {
    return { status: 404, body: { error: 'not found' } }
  }
  return { status: 200, body: status }
}
