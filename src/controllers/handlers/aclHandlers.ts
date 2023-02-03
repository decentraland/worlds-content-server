import { IHttpServerComponent } from '@well-known-components/interfaces'
import { AccessControlList, HandlerContextWithPath } from '../../types'

export async function getAclHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/acl/:world_name'>
): Promise<IHttpServerComponent.IResponse> {
  const worldMetadata = await ctx.components.worldsManager.getMetadataForWorld(ctx.params.world_name)
  if (!worldMetadata) {
    return {
      status: 404,
      body: `World "${ctx.params.world_name}" not deployed in this server.`
    }
  }

  if (!worldMetadata.acl) {
    return {
      status: 200,
      body: {
        resource: ctx.params.world_name,
        allowed: []
      } as AccessControlList
    }
  }

  // Get the last element of the auth chain. The payload must contain the AccessControlList
  const acl: AccessControlList = JSON.parse(worldMetadata.acl.slice(-1).pop()!.payload)

  // TODO check that the ACL was signed by the wallet that currently owns the world, or else return empty

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
