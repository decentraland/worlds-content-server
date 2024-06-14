import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'
import { InvalidRequestError } from '@dcl/platform-server-commons'
import { FormDataContext } from '../../logic/multipart'
import { extractFromContext } from '../../logic/extract-deployment-info'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new Error('A string was expected')
  return val
}

export async function startDeployEntity(
  ctx: FormDataContext &
    HandlerContextWithPath<'config' | 'deploymentV2Manager' | 'storage' | 'preDeploymentValidator', '/v2/entities'>
): Promise<IHttpServerComponent.IResponse> {
  const { authChain, entity, entityRaw, uploadedFiles } = extractFromContext(ctx)

  const contentHashesInStorage = await ctx.components.storage.existMultiple(
    Array.from(new Set(entity.content!.map(($) => $.hash)))
  )

  const fileSizesManifest = JSON.parse(ctx.formData.fields.fileSizesManifest.value.toString())

  // run all validations about the deployment
  const validationResult = await ctx.components.preDeploymentValidator.validate({
    entity,
    files: uploadedFiles,
    authChain,
    contentHashesInStorage,
    fileSizesManifest
  })
  if (!validationResult.ok()) {
    throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
  }

  const ongoingDeploymentData = await ctx.components.deploymentV2Manager.initDeployment(
    entity.id,
    entityRaw,
    authChain,
    fileSizesManifest
  )

  return {
    status: 200,
    body: {
      availableFiles: ongoingDeploymentData.availableFiles,
      missingFiles: ongoingDeploymentData.missingFiles
    }
  }
}

export async function deployFile(
  ctx: HandlerContextWithPath<'deploymentV2Manager', '/v2/entities/:entityId/files/:fileHash'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = await ctx.params.entityId
  const fileHash = await ctx.params.fileHash
  const buffer = await ctx.request.buffer()

  await ctx.components.deploymentV2Manager.addFileToDeployment(entityId, fileHash, buffer)

  return {
    status: 204,
    body: {}
  }
}

export async function finishDeployEntity(
  ctx: HandlerContextWithPath<
    'config' | 'deploymentV2Manager' | 'entityDeployer' | 'storage' | 'validator',
    '/v2/entities/:entityId'
  >
): Promise<IHttpServerComponent.IResponse> {
  const baseUrl = (await ctx.components.config.getString('HTTP_BASE_URL')) || `https://${ctx.url.host}`

  const message = await ctx.components.deploymentV2Manager.completeDeployment(baseUrl, ctx.params.entityId)
  return {
    status: 204,
    body: {
      creationTimestamp: Date.now(),
      message
    }
  }
}
