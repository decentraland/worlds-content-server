import { IHttpServerComponent } from '@well-known-components/interfaces'
import { AccessControlList, HandlerContextWithPath } from '../../types'

export async function getAclHandler(
  ctx: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/acl/:world_name'>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, worldsManager } = ctx.components

  const worldName = ctx.params.world_name

  const worldMetadata = await worldsManager.getMetadataForWorld(worldName)
  if (!worldMetadata) {
    return {
      status: 404,
      body: `World "${worldName}" not deployed in this server.`
    }
  }

  if (!worldMetadata.acl) {
    return {
      status: 200,
      body: {
        resource: worldName,
        allowed: []
      } as AccessControlList
    }
  }

  // Check that the ACL was signed by the wallet that currently owns the world, or else return empty
  const ethAddress = worldMetadata.acl[0].payload
  const permission = await namePermissionChecker.checkPermission(ethAddress, worldName)
  const acl: AccessControlList = !permission
    ? {
        resource: worldName,
        allowed: []
      }
    : // Get the last element of the auth chain. The payload must contain the AccessControlList
      JSON.parse(worldMetadata.acl.slice(-1).pop()!.payload)

  return {
    status: 200,
    body: acl
  }
}

export async function postAclHandler(
  ctx: HandlerContextWithPath<
    'config' | 'logs' | 'namePermissionChecker' | 'metrics' | 'storage' | 'sns' | 'validator',
    '/acl/:world_name'
  >
): Promise<IHttpServerComponent.IResponse> {
  const logger = ctx.components.logs.getLogger('deploy')
  try {
    return {
      status: 200,
      body: {
        acl: {}
      }
    }
  } catch (err: any) {
    logger.error(err)
    throw err
  }
}
