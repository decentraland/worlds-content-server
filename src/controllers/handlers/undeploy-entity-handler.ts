import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'
import { InvalidRequestError } from '@dcl/http-commons'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'

export async function undeployEntity({
  params,
  components: { logs, namePermissionChecker, permissions, worlds },
  verification
}: HandlerContextWithPath<'logs' | 'namePermissionChecker' | 'permissions' | 'worlds', '/entities/:world_name'> &
  DecentralandSignatureContext<any>): Promise<IHttpServerComponent.IResponse> {
  const logger = logs.getLogger('worlds-manager')

  const identity = verification!.auth

  const isOwner = await namePermissionChecker.checkPermission(identity, params.world_name)
  if (!isOwner) {
    // Only users with world-wide deployment permissions can undeploy a whole world
    const hasWorldWidePermission = await permissions.hasWorldWidePermission(
      params.world_name,
      'deployment',
      verification!.auth!
    )
    if (!hasWorldWidePermission) {
      throw new InvalidRequestError(
        'Invalid request. You must have world-wide deployment permission to undeploy the entire world.'
      )
    }
  }

  logger.info(`Un-deploying world ${params.world_name}`)
  await worlds.undeployWorld(params.world_name)

  return {
    status: 200,
    body: '{}'
  }
}
