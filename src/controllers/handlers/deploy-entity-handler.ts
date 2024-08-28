import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/platform-server-commons'
import { FormDataContext } from '../../logic/multipart'
import { HandlerContextWithPath } from '../../types'
import { extractFromContext } from '../../logic/extract-deployment-info'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new Error('A string was expected')
  return val
}

export async function deployEntity(
  ctx: FormDataContext & HandlerContextWithPath<'config' | 'entityDeployer' | 'storage' | 'validator', '/entities'>
): Promise<IHttpServerComponent.IResponse> {
  const { authChain, entity, entityRaw, uploadedFiles } = extractFromContext(ctx)

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
    entityRaw.toString(),
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
