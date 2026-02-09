import { EthAddress } from '@dcl/schemas'

/**
 * Access checker: answers whether an identity has access to a world
 * according to the current stored access settings.
 */
export interface IAccessCheckerComponent {
  checkAccess(worldName: string, ethAddress: EthAddress, extras?: any): Promise<boolean>
}
