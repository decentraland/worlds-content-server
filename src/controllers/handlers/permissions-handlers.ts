import { IHttpServerComponent } from '@well-known-components/interfaces'
import { HandlerContextWithPath, IWorldNamePermissionChecker } from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { getPaginationParams, InvalidRequestError, NotAuthorizedError, NotFoundError } from '@dcl/http-commons'
import { EthAddress } from '@dcl/schemas'
import {
  AllowListPermission,
  InvalidPermissionRequestError,
  PermissionNotFoundError,
  PermissionType
} from '../../logic/permissions'
import { AccessInput, AccessSetting, AccessType, InvalidAccessTypeError } from '../../logic/access'
import { PermissionParcelsInput } from '../schemas/permission-parcels-schema'

function isAllowListPermission(permission: string): permission is AllowListPermission {
  return permission === 'deployment' || permission === 'streaming'
}

type PermissionTypeName = 'access' | 'deployment' | 'streaming'

function isValidPermissionType(permission: string): permission is PermissionTypeName {
  return permission === 'access' || permission === 'deployment' || permission === 'streaming'
}

function removeSecrets(access: AccessSetting): AccessSetting {
  const noSecrets = JSON.parse(JSON.stringify(access)) as AccessSetting
  if (noSecrets.type === AccessType.SharedSecret) {
    delete (noSecrets as any).secret
  }
  return noSecrets
}

async function checkOwnership(namePermissionChecker: IWorldNamePermissionChecker, signer: string, worldName: string) {
  const hasPermission = await namePermissionChecker.checkPermission(signer, worldName)
  if (!hasPermission) {
    throw new NotAuthorizedError(
      `Your wallet does not own "${worldName}", you can not set access control lists for it.`
    )
  }
}

export async function getPermissionsHandler(
  ctx: HandlerContextWithPath<'permissions' | 'permissionsManager' | 'worldsManager', '/world/:world_name/permissions'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissions, permissionsManager, worldsManager } = ctx.components
  const worldName = ctx.params.world_name

  const [metadata, owner, summary] = await Promise.all([
    worldsManager.getMetadataForWorld(worldName),
    permissionsManager.getOwner(worldName),
    permissions.getPermissionsSummary(worldName)
  ])

  // Extract wallets for deployment and streaming from summary
  const deploymentWallets: string[] = []
  const streamingWallets: string[] = []

  for (const [address, addressPermissions] of Object.entries(summary)) {
    for (const perm of addressPermissions) {
      if (perm.permission === 'deployment') {
        deploymentWallets.push(address)
      } else if (perm.permission === 'streaming') {
        streamingWallets.push(address)
      }
    }
  }

  // Access settings (with secrets removed)
  const access = metadata?.access || { type: AccessType.Unrestricted }
  const accessWithoutSecrets = removeSecrets(access)

  // Streaming is allow-list if there are entries, unrestricted otherwise
  const hasStreamingEntries = streamingWallets.length > 0

  // Transform summary to snake_case for the response
  const transformedSummary: Record<string, { permission: string; world_wide: boolean; parcel_count?: number }[]> = {}
  for (const [address, addressPermissions] of Object.entries(summary)) {
    transformedSummary[address] = addressPermissions.map((perm) => ({
      permission: perm.permission,
      world_wide: perm.worldWide,
      ...(perm.parcelCount !== undefined ? { parcel_count: perm.parcelCount } : {})
    }))
  }

  return {
    status: 200,
    body: {
      permissions: {
        deployment: {
          type: PermissionType.AllowList,
          wallets: deploymentWallets
        },
        streaming: hasStreamingEntries
          ? {
              type: PermissionType.AllowList,
              wallets: streamingWallets
            }
          : { type: PermissionType.Unrestricted },
        access: accessWithoutSecrets
      },
      owner,
      summary: transformedSummary
    }
  }
}

type PermissionOrAccess = 'deployment' | 'streaming' | 'access'

export async function postPermissionsHandler(
  ctx: HandlerContextWithPath<
    'access' | 'namePermissionChecker' | 'permissions',
    '/world/:world_name/permissions/:permission_name'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { access, namePermissionChecker, permissions } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as PermissionOrAccess

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const authMetadata = ctx.verification!.authMetadata

  try {
    switch (permissionName) {
      case 'deployment': {
        await permissions.setDeploymentPermission(
          worldName,
          authMetadata.type as PermissionType,
          authMetadata.wallets || []
        )
        break
      }
      case 'streaming': {
        await permissions.setStreamingPermission(worldName, authMetadata.type as PermissionType, authMetadata.wallets)
        break
      }
      case 'access': {
        try {
          await access.setAccess(worldName, authMetadata as AccessInput)
        } catch (error) {
          if (error instanceof InvalidAccessTypeError) {
            throw new InvalidRequestError(error.message)
          }
          throw error
        }
        break
      }
      default: {
        throw new InvalidRequestError(`Invalid permission name: ${permissionName}.`)
      }
    }
  } catch (error) {
    if (error instanceof InvalidPermissionRequestError) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

  return {
    status: 204
  }
}

/**
 * Grant world-wide permission to an address - idempotent PUT operation
 */
export async function putPermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  await permissions.grantWorldWidePermission(worldName, permissionName, [address])

  return { status: 204 }
}

/**
 * Add parcels to an existing permission
 * POST /world/:world_name/permissions/:permission_name/address/:address/parcels
 */
export async function postPermissionParcelsHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions',
    '/world/:world_name/permissions/:permission_name/address/:address/parcels'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions } = ctx.components
  const { world_name: worldName, permission_name: permissionName, address } = ctx.params

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const { parcels } = (await ctx.request.json()) as PermissionParcelsInput

  await permissions.addParcelsToPermission(worldName, permissionName, address, parcels)

  return { status: 204 }
}

/**
 * Remove parcels from an existing permission
 * DELETE /world/:world_name/permissions/:permission_name/address/:address/parcels
 */
export async function deletePermissionParcelsHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions',
    '/world/:world_name/permissions/:permission_name/address/:address/parcels'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions } = ctx.components
  const { world_name: worldName, permission_name: permissionName, address } = ctx.params

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const { parcels } = (await ctx.request.json()) as PermissionParcelsInput

  try {
    await permissions.removeParcelsFromPermission(worldName, permissionName, address, parcels)
  } catch (error) {
    if (error instanceof InvalidPermissionRequestError) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

  return { status: 204 }
}

/**
 * Get parcels for a specific address permission with pagination.
 * Optionally filter by a bounding box using x1, y1, x2, y2 query parameters.
 */
export async function getAllowedParcelsForPermissionHandler(
  ctx: HandlerContextWithPath<'permissions', '/world/:world_name/permissions/:permission_name/address/:address/parcels'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissions } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  // Parse pagination from URL params
  const { limit, offset } = getPaginationParams(ctx.url.searchParams)

  // Parse optional bounding box parameters
  const x1Param = ctx.url.searchParams.get('x1')
  const y1Param = ctx.url.searchParams.get('y1')
  const x2Param = ctx.url.searchParams.get('x2')
  const y2Param = ctx.url.searchParams.get('y2')

  let boundingBox: { x1: number; y1: number; x2: number; y2: number } | undefined

  // All four parameters must be provided together
  if (x1Param !== null || y1Param !== null || x2Param !== null || y2Param !== null) {
    if (x1Param === null || y1Param === null || x2Param === null || y2Param === null) {
      throw new InvalidRequestError('Bounding box requires all four parameters: x1, y1, x2, y2.')
    }

    const x1 = parseInt(x1Param, 10)
    const y1 = parseInt(y1Param, 10)
    const x2 = parseInt(x2Param, 10)
    const y2 = parseInt(y2Param, 10)

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
      throw new InvalidRequestError('Bounding box parameters must be valid integers.')
    }

    boundingBox = { x1, y1, x2, y2 }
  }

  try {
    const result = await permissions.getAllowedParcelsForPermission(
      worldName,
      permissionName,
      address,
      limit,
      offset,
      boundingBox
    )

    // If total is 0, it means world-wide access (no parcel restrictions)
    return {
      status: 200,
      body: {
        total: result.total,
        parcels: result.results
      }
    }
  } catch (error) {
    if (error instanceof PermissionNotFoundError) {
      throw new NotFoundError(error.message)
    }
    throw error
  }
}

/**
 * Delete permission for an address
 */
export async function deletePermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  // Revoke permission from the address (handles delete and notification)
  await permissions.revokePermission(worldName, permissionName, [address])

  return { status: 204 }
}

/**
 * Get a specific permission for a world.
 * Authorization: owner or manager for 'access', public for 'deployment' and 'streaming'.
 */
export async function getPermissionHandler(
  ctx: HandlerContextWithPath<
    'access' | 'permissions' | 'permissionsManager' | 'worldsManager',
    '/world/:world_name/permissions/:permission_name'
  >
): Promise<IHttpServerComponent.IResponse> {
  const { permissions, worldsManager } = ctx.components
  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name

  if (!isValidPermissionType(permissionName)) {
    throw new InvalidRequestError(
      `Invalid permission name: ${permissionName}. Valid names are: access, deployment, streaming.`
    )
  }

  if (permissionName === 'access') {
    const metadata = await worldsManager.getMetadataForWorld(worldName)
    const accessSetting = metadata?.access || { type: AccessType.Unrestricted }
    const accessWithoutSecrets = removeSecrets(accessSetting)

    return {
      status: 200,
      body: accessWithoutSecrets
    }
  }

  // For deployment and streaming, get from the summary
  const summary = await permissions.getPermissionsSummary(worldName)
  const wallets: string[] = []

  for (const [address, addressPermissions] of Object.entries(summary)) {
    for (const perm of addressPermissions) {
      if (perm.permission === permissionName) {
        wallets.push(address)
      }
    }
  }

  // Streaming is unrestricted if no entries, deployment is always allow-list
  if (permissionName === 'streaming' && wallets.length === 0) {
    return {
      status: 200,
      body: { type: PermissionType.Unrestricted }
    }
  }

  return {
    status: 200,
    body: {
      type: PermissionType.AllowList,
      wallets
    }
  }
}

/**
 * Check if an address has a specific permission for a world.
 * Returns 204 if the address has the permission, 403 if not.
 * This endpoint is public to allow access checks.
 */
export async function checkAddressPermissionHandler(
  ctx: HandlerContextWithPath<
    'access' | 'permissions' | 'permissionsManager' | 'worldsManager',
    '/world/:world_name/permissions/:permission_name/:address'
  >
): Promise<IHttpServerComponent.IResponse> {
  const { access, permissions, permissionsManager } = ctx.components
  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!isValidPermissionType(permissionName)) {
    throw new InvalidRequestError(
      `Invalid permission name: ${permissionName}. Valid names are: access, deployment, streaming.`
    )
  }

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  const lowerAddress = address.toLowerCase()

  // Check if address is owner - owners have all permissions
  const owner = await permissionsManager.getOwner(worldName)
  if (owner && owner.toLowerCase() === lowerAddress) {
    return { status: 204 }
  }

  if (permissionName === 'access') {
    // Check access permission
    const hasAccess = await access.checkAccess(worldName, lowerAddress)
    if (hasAccess) {
      return { status: 204 }
    }
    return {
      status: 403,
      body: {
        error: 'Forbidden',
        message: `Address ${address} does not have access permission for world ${worldName}.`
      }
    }
  }

  // For deployment and streaming, check if the address has world-wide permission
  // (for parcel-specific permissions, use the parcels endpoint)
  const hasWorldWide = await permissions.hasWorldWidePermission(worldName, permissionName, lowerAddress)
  if (hasWorldWide) {
    return { status: 204 }
  }

  // Also check if they have any parcel-specific permission (they still have "some" permission)
  const summary = await permissions.getPermissionsSummary(worldName)
  const addressPermissions = summary[lowerAddress]
  if (addressPermissions) {
    const hasPermission = addressPermissions.some((p) => p.permission === permissionName)
    if (hasPermission) {
      return { status: 204 }
    }
  }

  return {
    status: 403,
    body: {
      error: 'Forbidden',
      message: `Address ${address} does not have ${permissionName} permission for world ${worldName}.`
    }
  }
}
