import { IHttpServerComponent } from '@well-known-components/interfaces'
import { AccessControlList, HandlerContextWithPath } from '../../types'
import { AuthChain } from '@dcl/schemas'

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
  ctx: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/acl/:world_name'>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, worldsManager } = ctx.components

  const worldName = ctx.params.world_name

  const worldMetadata = await worldsManager.getMetadataForWorld(worldName)
  if (!worldMetadata) {
    return {
      status: 404,
      body: {
        message: `World "${worldName}" not deployed in this server.`
      }
    }
  }

  const authChain = (await ctx.request.json()) as AuthChain
  if (!authChain || !Array.isArray(authChain)) {
    return {
      status: 400,
      body: {
        message: `Invalid payload received. Need to be a valid AuthChain.`
      }
    }
  }

  const permission = await namePermissionChecker.checkPermission(authChain[0].payload, worldName)
  if (!permission) {
    return {
      status: 403,
      body: {
        message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
      }
    }
  }

  const acl = JSON.parse(authChain.slice(-1).pop()!.payload)
  await worldsManager.storeAcl(acl)

  return {
    status: 200,
    body: acl
  }
}
