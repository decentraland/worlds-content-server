import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath, InvalidRequestError } from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'

export async function undeployEntity({
  params,
  components: { namePermissionChecker, worldsManager },
  verification
}: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/entities/:world_name'> &
  DecentralandSignatureContext<any>): Promise<IHttpServerComponent.IResponse> {
  const identity = verification!.auth

  const isOwner = await namePermissionChecker.checkPermission(identity, params.world_name)
  if (!isOwner) {
    const checkerForWorld = await worldsManager.permissionCheckerForWorld(params.world_name)
    const hasPermission = await checkerForWorld.checkPermission('deployment', verification!.auth!)
    console.log('hasPermission', verification!.auth!, hasPermission)
    if (!hasPermission) {
      throw new InvalidRequestError('Invalid request. You have no permission to undeploy the scene.')
    }
  }

  await worldsManager.undeploy(params.world_name)

  return {
    status: 200,
    body: '{}'
  }
}
