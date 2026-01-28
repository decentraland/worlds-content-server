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

/**
 * Error thrown when a permission request is invalid.
 * This error should be caught by handlers and converted to an appropriate HTTP error.
 */
export class InvalidPermissionRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPermissionRequestError'
  }
}
