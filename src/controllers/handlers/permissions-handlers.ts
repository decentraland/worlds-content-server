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
import {
  AccessInput,
  AccessSetting,
  AccessType,
  InvalidAccessTypeError,
  InvalidAllowListSettingError,
  NotAllowListAccessError,
  UnauthorizedCommunityError
} from '../../logic/access'
import { PermissionParcelsInput } from '../schemas/permission-parcels-schema'

function isAllowListPermission(permission: string): permission is AllowListPermission {
  return permission === 'deployment' || permission === 'streaming'
}

type PermissionWithWalletSupport = AllowListPermission | 'access'

function isPermissionWithWalletSupport(permission: string): permission is PermissionWithWalletSupport {
  return permission === 'deployment' || permission === 'streaming' || permission === 'access'
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
  ctx: HandlerContextWithPath<'access' | 'permissions' | 'permissionsManager', '/world/:world_name/permissions'>
): Promise<IHttpServerComponent.IResponse> {
  const { access, permissions, permissionsManager } = ctx.components
  const worldName = ctx.params.world_name

  const [worldAccess, owner, summary] = await Promise.all([
    access.getAccessForWorld(worldName),
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
  const accessWithoutSecrets = removeSecrets(worldAccess)

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
        streaming: {
          type: PermissionType.AllowList,
          wallets: streamingWallets
        },
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
          ctx.verification!.auth,
          authMetadata.type as PermissionType,
          authMetadata.wallets || []
        )
        break
      }
      case 'streaming': {
        await permissions.setStreamingPermission(
          worldName,
          ctx.verification!.auth,
          authMetadata.type as PermissionType,
          authMetadata.wallets
        )
        break
      }
      case 'access': {
        await access.setAccess(worldName, ctx.verification!.auth, authMetadata as AccessInput)
        break
      }
      default: {
        throw new InvalidRequestError(`Invalid permission name: ${permissionName}.`)
      }
    }
  } catch (error) {
    if (
      error instanceof InvalidPermissionRequestError ||
      error instanceof InvalidAccessTypeError ||
      error instanceof UnauthorizedCommunityError ||
      error instanceof InvalidAllowListSettingError
    ) {
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
 * For deployment/streaming: grants world-wide permission to the address
 * For access: adds the wallet to the access allow-list
 */
export async function putPermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions' | 'access',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions, access } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isPermissionWithWalletSupport(permissionName)) {
    throw new InvalidRequestError(`Invalid permission name: ${permissionName}.`)
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  try {
    if (isAllowListPermission(permissionName)) {
      await permissions.grantWorldWidePermission(worldName, permissionName, [address], ctx.verification!.auth)
    } else {
      // permissionName === 'access'
      await access.addWalletToAccessAllowList(worldName, ctx.verification!.auth, address)
    }
  } catch (error) {
    if (error instanceof NotAllowListAccessError || error instanceof InvalidAllowListSettingError) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

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
 * Get addresses that have a specific permission for a given parcel with pagination.
 * Includes addresses with world-wide permission and parcel-specific permission.
 */
export async function getAddressesForParcelPermissionHandler(
  ctx: HandlerContextWithPath<'permissions', '/world/:world_name/permissions/:permission_name/parcels/:parcel'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissions } = ctx.components
  const { world_name: worldName, permission_name: permissionName, parcel } = ctx.params

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  const { limit, offset } = getPaginationParams(ctx.url.searchParams)

  const result = await permissions.getAddressesForParcelPermission(worldName, permissionName, parcel, limit, offset)

  return {
    status: 200,
    body: {
      total: result.total,
      addresses: result.results
    }
  }
}

/**
 * Delete permission for an address
 * For deployment/streaming: revokes the permission from the address
 * For access: removes the wallet from the access allow-list
 */
export async function deletePermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissions' | 'access' | 'worlds',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissions, access, worlds } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  if (!isPermissionWithWalletSupport(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment', 'streaming', and 'access' do.`
    )
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  // Return 404 if the world does not exist or is not valid
  const isValid = await worlds.isWorldValid(worldName)
  if (!isValid) {
    throw new NotFoundError(`World "${worldName}" not found.`)
  }

  try {
    if (isAllowListPermission(permissionName)) {
      // Revoke permission from the address (handles delete and notification)
      await permissions.revokePermission(worldName, permissionName, [address])
    } else {
      // permissionName === 'access'
      await access.removeWalletFromAccessAllowList(worldName, address)
    }
  } catch (error) {
    if (error instanceof NotAllowListAccessError) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

  return { status: 204 }
}

/**
 * Add a community to the access allow-list for a world.
 * PUT /world/:world_name/permissions/access/communities/:communityId
 * The signer must be a member of the community being added.
 */
export async function putPermissionsAccessCommunityHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'access',
    '/world/:world_name/permissions/access/communities/:communityId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, access } = ctx.components

  const worldName = ctx.params.world_name
  const communityId = ctx.params.communityId

  if (!communityId || communityId.trim() === '') {
    throw new InvalidRequestError('Invalid community id.')
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  try {
    await access.addCommunityToAccessAllowList(worldName, ctx.verification!.auth, communityId)
  } catch (error) {
    if (
      error instanceof NotAllowListAccessError ||
      error instanceof UnauthorizedCommunityError ||
      error instanceof InvalidAllowListSettingError
    ) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

  return { status: 204 }
}

/**
 * Remove a community from the access allow-list for a world.
 * DELETE /world/:world_name/permissions/access/communities/:communityId
 */
export async function deletePermissionsAccessCommunityHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'access',
    '/world/:world_name/permissions/access/communities/:communityId'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, access } = ctx.components

  const worldName = ctx.params.world_name
  const communityId = ctx.params.communityId

  if (!communityId || communityId.trim() === '') {
    throw new InvalidRequestError('Invalid community id.')
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  try {
    await access.removeCommunityFromAccessAllowList(worldName, communityId)
  } catch (error) {
    if (error instanceof NotAllowListAccessError) {
      throw new InvalidRequestError(error.message)
    }
    throw error
  }

  return { status: 204 }
}
