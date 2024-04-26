import { IHttpServerComponent } from '@well-known-components/interfaces'
import {
  HandlerContextWithPath,
  IWorldNamePermissionChecker,
  Permission,
  Permissions,
  PermissionType
} from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import bcrypt from 'bcrypt'
import { InvalidRequestError, NotAuthorizedError } from '@dcl/platform-server-commons'
import { EthAddress } from '@dcl/schemas'
import { defaultPermissions } from '../../logic/permissions-checker'

const saltRounds = 10

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
    throw new NotAuthorizedError(
      `Your wallet does not own "${worldName}", you can not set access control lists for it.`
    )
  }
}

export async function getPermissionsHandler(
  ctx: HandlerContextWithPath<'permissionsManager', '/world/:world_name/permissions'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissionsManager } = ctx.components

  const permissions = await permissionsManager.getPermissions(ctx.params.world_name)

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

  const permissions = await permissionsManager.getPermissions(worldName)
  switch (permissionName) {
    case 'deployment': {
      switch (type) {
        case PermissionType.AllowList: {
          permissions.deployment = { type: PermissionType.AllowList, wallets: [] }
          break
        }
        default: {
          throw new InvalidRequestError(
            `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
          )
        }
      }
      break
    }
    case 'streaming': {
      switch (type) {
        case PermissionType.AllowList: {
          permissions.streaming = { type: PermissionType.AllowList, wallets: [] }
          break
        }
        case PermissionType.Unrestricted: {
          permissions.streaming = { type: PermissionType.Unrestricted }
          break
        }
        default: {
          throw new InvalidRequestError(
            `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
          )
        }
      }
      break
    }
    case 'access': {
      switch (type) {
        case PermissionType.AllowList: {
          permissions.access = { type: PermissionType.AllowList, wallets: [] }
          break
        }
        case PermissionType.Unrestricted: {
          permissions.access = { type: PermissionType.Unrestricted }
          break
        }
        case PermissionType.NFTOwnership: {
          if (!extras.nft) {
            throw new InvalidRequestError('Invalid payload received. For nft ownership there needs to be a valid nft.')
          }
          permissions.access = { type: PermissionType.NFTOwnership, nft: extras.nft }
          break
        }
        case PermissionType.SharedSecret: {
          if (!extras.secret) {
            throw new InvalidRequestError(
              'Invalid payload received. For shared secret there needs to be a valid secret.'
            )
          }
          permissions.access = {
            type: PermissionType.SharedSecret,
            secret: bcrypt.hashSync(extras.secret, saltRounds)
          }
          break
        }
        default: {
          throw new InvalidRequestError(`Invalid payload received. Need to provide a valid permission type: ${type}.`)
        }
      }
      break
    }
  }
  await permissionsManager.storePermissions(worldName, permissions)

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
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

  await checkOwnership(namePermissionChecker, ctx.verification!.auth, worldName)

  const metadata = await worldsManager.getMetadataForWorld(worldName)
  const permissions = metadata?.permissions || defaultPermissions()
  const permissionConfig = permissions[permissionName]
  if (permissionConfig.type !== PermissionType.AllowList) {
    throw new InvalidRequestError(
      `World ${worldName} is configured as ${permissionConfig.type} (not '${PermissionType.AllowList}') for permission '${permissionName}'.`
    )
  }

  const lowerCaseAddress = address.toLowerCase()
  if (permissionConfig.wallets.includes(lowerCaseAddress)) {
    throw new InvalidRequestError(
      `World ${worldName} already has address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  await permissionsManager.addAddressToAllowList(worldName, permissionName, lowerCaseAddress)

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
  const address = ctx.params.address

  if (!EthAddress.validate(address)) {
    throw new InvalidRequestError(`Invalid address: ${address}.`)
  }

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

  const lowerCaseAddress = address.toLowerCase()
  if (!permissionConfig.wallets.includes(lowerCaseAddress)) {
    throw new InvalidRequestError(
      `World ${worldName} does not have address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  await permissionsManager.deleteAddressFromAllowList(worldName, permissionName, lowerCaseAddress)

  return {
    status: 204
  }
}
