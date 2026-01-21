import { AllowListPermission } from './types'

/**
 * Error thrown when a permission record is not found.
 */
export class PermissionNotFoundError extends Error {
  constructor(
    public readonly worldName: string,
    public readonly permission: AllowListPermission,
    public readonly address: string
  ) {
    super(`Address ${address} does not have ${permission} permission for world ${worldName}.`)
    this.name = 'PermissionNotFoundError'
  }
}
