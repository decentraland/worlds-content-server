import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError, NotAuthorizedError, getPaginationParams } from '@dcl/platform-server-commons'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { HandlerContextWithPath } from '../../types'

// Validate coordinate format (x,y where x and y are integers)
const COORDINATE_REGEX = /^-?\d+,-?\d+$/

function validateCoordinate(coordinate: string): void {
  if (!COORDINATE_REGEX.test(coordinate)) {
    throw new InvalidRequestError(`Invalid coordinate format: ${coordinate}. Expected format: x,y (e.g., 0,0 or -1,2)`)
  }
}

export async function getScenesHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/scenes'>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name } = ctx.params

  // Parse optional coordinates array from query params
  const coordinates = ctx.url.searchParams.getAll('coordinates')

  // Validate coordinates if provided
  coordinates.forEach(validateCoordinate)

  // Parse optional pagination params
  const { limit, offset } = getPaginationParams(ctx.url.searchParams)

  const filters = {
    worldName: world_name,
    ...(coordinates.length > 0 && { coordinates })
  }

  const { scenes, total } = await ctx.components.worldsManager.getWorldScenes(filters, { limit, offset })

  // Convert BigInt values to strings for JSON serialization
  const serializedScenes = scenes.map((scene) => ({
    ...scene,
    size: scene.size.toString()
  }))

  return {
    status: 200,
    body: { scenes: serializedScenes, total }
  }
}

export async function undeploySceneHandler(
  ctx: HandlerContextWithPath<'namePermissionChecker' | 'worldsManager', '/world/:world_name/scenes/:coordinate'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { world_name, coordinate } = ctx.params
  const signer = ctx.verification!.auth.toLowerCase()

  validateCoordinate(coordinate)

  // Check if user owns the name
  const hasNamePermission = await ctx.components.namePermissionChecker.checkPermission(signer, world_name)

  if (!hasNamePermission) {
    // Check if user has deployment permissions
    const permissionChecker = await ctx.components.worldsManager.permissionCheckerForWorld(world_name)
    const hasDeploymentPermission = await permissionChecker.checkPermission('deployment', signer)

    if (!hasDeploymentPermission) {
      throw new NotAuthorizedError('Unauthorized. You do not have permission to undeploy scenes in this world.')
    }
  }

  await ctx.components.worldsManager.undeployScene(world_name, [coordinate])

  return {
    status: 200,
    body: { message: `Scene at parcel ${coordinate} undeployed successfully` }
  }
}
