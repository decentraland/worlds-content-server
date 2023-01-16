import { AppComponents, IWorldNamePermissionChecker } from '../types'
import { EthAddress } from '@dcl/schemas'
import { checkerAbi, checkerContracts, registrarContracts } from '@dcl/catalyst-contracts'
import { ContractFactory, RequestManager } from 'eth-connect'

export const createOnChainDclNameChecker = async (
  components: Pick<AppComponents, 'config' | 'logs' | 'ethereumProvider'>
): Promise<IWorldNamePermissionChecker> => {
  const logger = components.logs.getLogger('check-permissions')
  logger.info('Using OnChain DclNameChecker')
  const networkId = await components.config.requireString('NETWORK_ID')
  const networkName = networkId === '1' ? 'mainnet' : 'goerli'
  const factory = new ContractFactory(new RequestManager(components.ethereumProvider), checkerAbi)
  const checker = (await factory.at(checkerContracts[networkName])) as any

  const checkPermission = async (ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    const registrar = registrarContracts[networkName]
    const hasPermission = checker.checkName(ethAddress, registrar, worldName, undefined)

    logger.debug(`Checking name ${worldName} for address ${ethAddress}: ${hasPermission}`)

    return hasPermission
  }

  return {
    checkPermission
  }
}
