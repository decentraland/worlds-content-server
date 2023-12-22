import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath } from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export async function undeployEntity({
  params,
  components: { logs, namePermissionChecker, worldsManager },
  verification
}: HandlerContextWithPath<'logs' | 'namePermissionChecker' | 'worldsManager', '/entities/:world_name'> &
  DecentralandSignatureContext<any>): Promise<IHttpServerComponent.IResponse> {
  const logger = logs.getLogger('worlds-manager')

  const identity = verification!.auth

  const isOwner = await namePermissionChecker.checkPermission(identity, params.world_name)
  if (!isOwner) {
    const checkerForWorld = await worldsManager.permissionCheckerForWorld(params.world_name)
    const hasPermission = await checkerForWorld.checkPermission('deployment', verification!.auth!)
    if (!hasPermission) {
      throw new InvalidRequestError('Invalid request. You have no permission to undeploy the scene.')
    }
  }

  logger.info(`Un-deploying world ${params.world_name}`)
  await worldsManager.undeploy(params.world_name)

  return {
    status: 200,
    body: '{}'
  }
}
