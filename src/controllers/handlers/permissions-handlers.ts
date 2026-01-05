import { IHttpServerComponent } from '@well-known-components/interfaces'
import { randomUUID } from 'crypto'
import {
  AllowListPermission,
  HandlerContextWithPath,
  IWorldNamePermissionChecker,
  Permission,
  Permissions,
  PermissionType
} from '../../types'
import { DecentralandSignatureContext } from '@dcl/platform-crypto-middleware'
import bcrypt from 'bcrypt'
import { InvalidRequestError, NotAuthorizedError } from '@dcl/platform-server-commons'
import { EthAddress, WorldsPermissionGrantedEvent, WorldsPermissionRevokedEvent, Events } from '@dcl/schemas'
import { defaultPermissions } from '../../logic/permissions-checker'

function isAllowListPermission(permission: string): permission is AllowListPermission {
  return permission === 'deployment' || permission === 'streaming'
}

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

  // TODO: do single round to DB
  const [permissions, owner] = await Promise.all([
    permissionsManager.getPermissions(ctx.params.world_name),
    permissionsManager.getOwner(ctx.params.world_name)
  ])
  const noSecrets = removeSecrets(permissions)

  return {
    status: 200,
    body: { permissions: noSecrets, owner }
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
    'config' | 'namePermissionChecker' | 'permissionsManager' | 'worldsManager' | 'snsClient',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { config, namePermissionChecker, permissionsManager, worldsManager, snsClient } = ctx.components
  const builderUrl = await config.requireString('BUILDER_URL')

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as Permission
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

  const metadata = await worldsManager.getMetadataForWorld(worldName)
  const permissions = metadata?.permissions || defaultPermissions()
  const permissionConfig = permissions[permissionName]
  if (permissionConfig.type !== PermissionType.AllowList) {
    throw new InvalidRequestError(
      `World ${worldName} is configured as ${permissionConfig.type} (not '${PermissionType.AllowList}') for permission '${permissionName}'.`
    )
  }

  const lowerCaseAddress = address.toLowerCase()

  // Check if already exists in world_permissions table
  const existingPermission = await permissionsManager.getAddressPermissions(worldName, permissionName, lowerCaseAddress)
  if (existingPermission) {
    throw new InvalidRequestError(
      `World ${worldName} already has address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  // Get parcels from request body if provided (for parcel-specific permissions)
  const { parcels } = ctx.verification!.authMetadata || {}
  const validatedParcels = parcels && Array.isArray(parcels) ? parcels : undefined

  await permissionsManager.addAddressToAllowList(worldName, permissionName, lowerCaseAddress, validatedParcels)

  const permissionGrantedEvent: WorldsPermissionGrantedEvent = {
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.WORLDS_PERMISSION_GRANTED,
    key: randomUUID(),
    timestamp: Date.now(),
    metadata: {
      title: 'Worlds permission granted',
      description: validatedParcels
        ? `You have been granted ${permissionName} permission for parcels ${validatedParcels.join(', ')} in world ${worldName}`
        : `You have been granted ${permissionName} permission for world ${worldName}`,
      world: worldName,
      permissions: [permissionName],
      url: `${builderUrl}/worlds?tab=dcl`,
      address: lowerCaseAddress
    }
  }

  await snsClient.publishMessage(permissionGrantedEvent, {
    isMultiplayer: { DataType: 'String', StringValue: 'false' }
  })

  return {
    status: 204
  }
}

export async function deletePermissionsAddressHandler(
  ctx: HandlerContextWithPath<
    'config' | 'namePermissionChecker' | 'permissionsManager' | 'worldsManager' | 'snsClient',
    '/world/:world_name/permissions/:permission_name/:address'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { config, namePermissionChecker, permissionsManager, snsClient } = ctx.components
  const builderUrl = await config.requireString('BUILDER_URL')

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name as Permission
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

  const lowerCaseAddress = address.toLowerCase()

  // Check if exists in world_permissions table
  const existingPermission = await permissionsManager.getAddressPermissions(worldName, permissionName, lowerCaseAddress)
  if (!existingPermission) {
    throw new InvalidRequestError(
      `World ${worldName} does not have address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  await permissionsManager.deleteAddressFromAllowList(worldName, permissionName, lowerCaseAddress)

  const permissionRevokedEvent: WorldsPermissionRevokedEvent = {
    type: Events.Type.WORLD,
    subType: Events.SubType.Worlds.WORLDS_PERMISSION_REVOKED,
    key: randomUUID(),
    timestamp: Date.now(),
    metadata: {
      title: 'World permission revoked',
      description: `Your ${permissionName} permission for world ${worldName} has been revoked`,
      world: worldName,
      permissions: [permissionName],
      url: `${builderUrl}/worlds?tab=dcl`,
      address: lowerCaseAddress
    }
  }

  await snsClient.publishMessage(permissionRevokedEvent, {
    isMultiplayer: { DataType: 'String', StringValue: 'false' }
  })

  return {
    status: 204
  }
}

/**
 * Get detailed permissions for a specific address (including parcels)
 */
export async function getAddressPermissionsHandler(
  ctx: HandlerContextWithPath<'permissionsManager', '/world/:world_name/permissions/:permission_name/:address'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissionsManager } = ctx.components

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

  const lowerCaseAddress = address.toLowerCase()
  const permission = await permissionsManager.getAddressPermissions(worldName, permissionName, lowerCaseAddress)

  if (!permission) {
    return {
      status: 404,
      body: {
        error: 'Not found',
        message: `Address ${address} does not have ${permissionName} permission for world ${worldName}.`
      }
    }
  }

  return {
    status: 200,
    body: {
      worldName: permission.worldName,
      permissionType: permission.permissionType,
      address: permission.address,
      parcels: permission.parcels, // null means world-wide
      createdAt: permission.createdAt.toISOString(),
      updatedAt: permission.updatedAt.toISOString()
    }
  }
}

/**
 * Update parcels for an existing permission
 */
export async function patchAddressParcelsHandler(
  ctx: HandlerContextWithPath<
    'namePermissionChecker' | 'permissionsManager',
    '/world/:world_name/permissions/:permission_name/:address/parcels'
  > &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const { namePermissionChecker, permissionsManager } = ctx.components

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

  const lowerCaseAddress = address.toLowerCase()

  // Check if permission exists
  const existingPermission = await permissionsManager.getAddressPermissions(worldName, permissionName, lowerCaseAddress)
  if (!existingPermission) {
    throw new InvalidRequestError(
      `World ${worldName} does not have address ${address} in the allow list for permission '${permissionName}'.`
    )
  }

  // Get parcels from request body (null means world-wide)
  const { parcels } = ctx.verification!.authMetadata || {}
  const validatedParcels = parcels === null ? null : Array.isArray(parcels) ? parcels : null

  await permissionsManager.updateAddressParcels(worldName, permissionName, lowerCaseAddress, validatedParcels)

  return {
    status: 204
  }
}

/**
 * Get all permissions for a world (with parcel details)
 */
export async function getWorldPermissionsDetailedHandler(
  ctx: HandlerContextWithPath<'permissionsManager', '/world/:world_name/permissions/:permission_name/list'>
): Promise<IHttpServerComponent.IResponse> {
  const { permissionsManager } = ctx.components

  const worldName = ctx.params.world_name
  const permissionName = ctx.params.permission_name

  if (!isAllowListPermission(permissionName)) {
    throw new InvalidRequestError(
      `Permission '${permissionName}' does not support allow-list. Only 'deployment' and 'streaming' do.`
    )
  }

  const permissions = await permissionsManager.getWorldPermissions(worldName, permissionName)

  return {
    status: 200,
    body: {
      permissions: permissions.map((p) => ({
        address: p.address,
        parcels: p.parcels, // null means world-wide
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString()
      }))
    }
  }
}
