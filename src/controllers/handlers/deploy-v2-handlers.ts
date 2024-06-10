import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'
import { AuthChain } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/platform-server-commons'
import { Authenticator } from '@dcl/crypto'
import { StartDeploymentBody } from '../../adapters/deployment-v2-manager'

export function requireString(val: string | null | undefined): string {
  if (typeof val !== 'string') throw new Error('A string was expected')
  return val
}

export async function startDeployEntity(
  ctx: HandlerContextWithPath<'config' | 'deploymentV2Manager' | 'storage' | 'validator', '/v2/entities/:entityId'>
): Promise<IHttpServerComponent.IResponse> {
  const entityId = await ctx.params.entityId
  const body: StartDeploymentBody = await ctx.request.json()
  const authChain: AuthChain = body.authChain
  console.log('entityId', entityId, 'authChain', authChain, 'files', body.files)

  if (!AuthChain.validate(authChain)) {
    throw new InvalidRequestError('Invalid authChain received')
  }
  if (!(await Authenticator.validateSignature(entityId, authChain, null, 10))) {
    throw new InvalidRequestError('Invalid signature')
  }

  await ctx.components.deploymentV2Manager.initDeployment(entityId, authChain, body.files)

  return {
    status: 200,
    body: {
      creationTimestamp: Date.now()
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
  const message = await ctx.components.deploymentV2Manager.completeDeployment(ctx.params.entityId)
  return {
    status: 204,
    body: {
      creationTimestamp: Date.now(),
      message
    }
  }
}
