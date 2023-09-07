import { IHttpServerComponent } from '@well-known-components/interfaces'
import {
  AccessDeniedError,
  HandlerContextWithPath,
  InvalidRequestError,
  IWorldNamePermissionChecker,
  Permission,
  Permissions,
  PermissionType
} from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import { defaultPermissions } from '../../logic/permissions-checker'

function removeSecrets(permissions: Permissions): Permissions {
  const noSecrets = JSON.parse(JSON.stringify(permissions)) as Permissions
  for (const mayHaveSecret of Object.values(noSecrets)) {
    if (mayHaveSecret.type === PermissionType.SharedSecret) {
      delete (mayHaveSecret as any).secret
    }
  }
  return noSecrets
}

async function checkOwnership(namePermissionChecker: IWorldNamePermissionChecker, signer: string, worldName: string) {
  const hasPermission = await namePermissionChecker.checkPermission(signer, worldName)
  if (!hasPermission) {
    throw new AccessDeniedError(`Your wallet does not own "${worldName}", you can not set access control lists for it.`)
  }
}

export async function getPermissionsHandler(
  ctx: HandlerContextWithPath<'worldsManager', '/world/:world_name/permissions'>
): Promise<IHttpServerComponent.IResponse> {
  const { worldsManager } = ctx.components

  const worldMetadata = await worldsManager.getMetadataForWorld(ctx.params.world_name)
  const permissions = worldMetadata?.permissions || defaultPermissions()

  const noSecrets = removeSecrets(permissions)

  return {
    status: 200,
    body: { permissions: noSecrets }
  }
}

export async function postPermissionsHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissionsManager',
    '/world/:world_name/permissions/:permission_name'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissionsManager } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as Permission

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const { type, ...extras } = ctx.verification!.authMetadata
  if (
    !type ||
    ![
      PermissionType.Unrestricted,
      PermissionType.SharedSecret,
      PermissionType.NFTOwnership,
      PermissionType.AllowList
    ].includes(type)
  ) {
    throw new InvalidRequestError(`Invalid payload received. Need to provide a valid permission type: ${type}.`)
  } else if (type === PermissionType.SharedSecret && !extras.secret) {
    throw new InvalidRequestError('Invalid payload received. For shared secret there needs to be a valid secret.')
  } else if (type === PermissionType.NFTOwnership && !extras.nft) {
    throw new InvalidRequestError('Invalid payload received. For nft ownership there needs to be a valid nft.')
  }

  if (permissionName === 'deployment' && type !== PermissionType.AllowList) {
    throw new InvalidRequestError(
      `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
    )
  } else if (
    permissionName === 'streaming' &&
    type !== PermissionType.AllowList &&
    type !== PermissionType.Unrestricted
  ) {
    throw new InvalidRequestError(
      `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
    )
  }

  await permissionsManager.setPermissionType(worldName, permissionName, type, extras)

  return {
    status: 204
  }
}

export async function putPermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissionsManager' | 'worldsManager',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissionsManager, worldsManager } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as Permission

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const metadata = await worldsManager.getMetadataForWorld(worldName)
  if (!metadata || !metadata.permissions || !metadata.permissions[permissionName]) {
    throw new InvalidRequestError(`World ${worldName} does not have any permission type set for '${permissionName}'.`)
  }

  const permissionConfig = metadata.permissions[permissionName]
  if (permissionConfig?.type !== PermissionType.AllowList) {
    throw new InvalidRequestError(
      `World ${worldName} is configured as ${permissionConfig.type} (not '${PermissionType.AllowList}') for permission '${permissionName}'.`
    )
  }

  const address = ctx.params.address.toLowerCase()
  if (permissionConfig.wallets.includes(address)) {
    throw new InvalidRequestError(
      `World ${worldName} already has address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  await permissionsManager.addAddressToAllowList(worldName, permissionName, address)

  return {
    status: 204
  }
}

export async function deletePermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissionsManager' | 'worldsManager',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissionsManager, worldsManager } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as Permission

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const metadata = await worldsManager.getMetadataForWorld(worldName)
  if (!metadata || !metadata.permissions || !metadata.permissions[permissionName]) {
    throw new InvalidRequestError(`World ${worldName} does not have any permission type set for '${permissionName}'.`)
  }

  const permissionConfig = metadata.permissions[permissionName]
  if (permissionConfig?.type !== PermissionType.AllowList) {
    throw new InvalidRequestError(
      `World ${worldName} is configured as ${permissionConfig.type} (not '${PermissionType.AllowList}') for permission '${permissionName}'.`
    )
  }

  const address = ctx.params.address.toLowerCase()
  if (!permissionConfig.wallets.includes(address)) {
    throw new InvalidRequestError(
      `World ${worldName} does not have address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  await permissionsManager.deleteAddressFromAllowList(worldName, permissionName, address)

  return {
    status: 204
  }
}
