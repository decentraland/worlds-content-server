import { IHttpServerComponent } from '@dcl/core-commons'
import { HandlerContextWithPath } from '../../types'
import { InvalidRequestError } from '@dcl/http-commons'
import { DecentralandSignatureContext } from '@dcl/crypto-middleware'

export async function undeployEntity({
  params,
  components: { logs, namePermissionChecker, permissions, walletStats, worlds, worldsManager },
  verification
}: HandlerContextWithPath<
  'logs' | 'namePermissionChecker' | 'permissions' | 'walletStats' | 'worlds' | 'worldsManager',
  '/entities/:world_name'
> &
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

  const { records } = await worldsManager.getRawWorldRecords({ worldName: params.world_name })
  if (records.length > 0) {
    walletStats.clearBlockedIfUnderQuota(records[0].owner).catch((error) =>
      logger.error(`Failed to recheck blocked status for ${records[0].owner} after undeploy`, {
        error: error instanceof Error ? error.message : String(error)
      })
    )
  }

  return {
    status: 200,
    body: '{}'
  }
}
