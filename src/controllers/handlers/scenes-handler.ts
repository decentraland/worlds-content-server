import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-server-commons'

export async function getScenesHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/scenes'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const scenes = await ctx.components.worldsManager.getWorldScenes(world_name)

  return {
    status: 200,
    body: { scenes }
  }
}

export async function getOccupiedParcelsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/parcels'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const parcels = await ctx.components.worldsManager.getOccupiedParcels(world_name)

  return {
    status: 200,
    body: { parcels }
  }
}

export async function undeploySceneHandler(
  ctx: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/world/:world_name/scenes'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const signer = ctx.verification!.auth.toLowerCase()

  // Get parcels from query string or body
  const parcelsParam = ctx.url.searchParams.get('parcels')
  if (!parcelsParam) {
    return {
      status: 400,
      body: { error: 'Missing parcels parameter. Specify parcels as query parameter (e.g., ?parcels=0,0;0,1)' }
    }
  }

  const parcels = parcelsParam.split(';')

  // Check if user owns the name
  const hasNamePermission = await ctx.components.namePermissionChecker.checkPermission(signer, world_name)

  if (!hasNamePermission) {
    // Check if user has deployment permissions
    const permissionChecker = await ctx.components.worldsManager.permissionCheckerForWorld(world_name)
    const hasDeploymentPermission = await permissionChecker.checkPermission('deployment', signer)

    if (!hasDeploymentPermission) {
      return {
        status: 403,
        body: { error: 'Unauthorized. You do not have permission to undeploy scenes in this world.' }
      }
    }
  }

  await ctx.components.worldsManager.undeployScene(world_name, parcels)

  return {
    status: 200,
    body: { message: `Scene(s) at parcels ${parcels.join(', ')} undeployed successfully` }
  }
}

