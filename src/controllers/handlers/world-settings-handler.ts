import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { DecentralandSignatureContext } from '@dcl/platform-server-commons'

export async function getWorldSettingsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/settings'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const settings = await ctx.components.worldsManager.getWorldSettings(world_name)

  if (!settings) {
    return {
      status: 404,
      body: { error: `World "${world_name}" not found or has no settings configured.` }
    }
  }

  return {
    status: 200,
    body: settings
  }
}

export async function updateWorldSettingsHandler(
  ctx: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/world/:world_name/settings'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params
  const signer = ctx.verification!.auth.toLowerCase()

  // Check if user owns the name
  const hasNamePermission = await ctx.components.namePermissionChecker.checkPermission(signer, world_name)

  if (!hasNamePermission) {
    // Check if user has deployment permissions (which includes world settings)
    const permissionChecker = await ctx.components.worldsManager.permissionCheckerForWorld(world_name)
    const hasDeploymentPermission = await permissionChecker.checkPermission('deployment', signer)

    if (!hasDeploymentPermission) {
      return {
        status: 403,
        body: { error: 'Unauthorized. You do not have permission to update settings for this world.' }
      }
    }
  }

  const body = await ctx.request.json()

  // Validate settings structure
  if (!body.name) {
    return {
      status: 400,
      body: { error: 'Invalid settings. "name" is required.' }
    }
  }

  const settings = {
    name: body.name,
    description: body.description,
    miniMapConfig: body.miniMapConfig,
    skyboxConfig: body.skyboxConfig,
    fixedAdapter: body.fixedAdapter,
    thumbnailFile: body.thumbnailFile
  }

  await ctx.components.worldsManager.updateWorldSettings(world_name, settings)

  return {
    status: 200,
    body: { message: 'World settings updated successfully', settings }
  }
}

