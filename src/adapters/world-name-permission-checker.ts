import { AppComponents, DeploymentToValidate, IWorldNamePermissionChecker } from '../types'
import { EthAddress } from '@dcl/schemas'

export async function createWorldNamePermissionChecker(
  components: Pick<AppComponents, 'config' | 'dclNameChecker' | 'fetch' | 'logs'>
): Promise<IWorldNamePermissionChecker> {
  const logger = components.logs.getLogger('check-permissions')
  const nameValidatorStrategy = await components.config.requireString('NAME_VALIDATOR')
  switch (nameValidatorStrategy) {
    case 'THE_GRAPH_DCL_NAME_CHECKER':
    case 'ON_CHAIN_DCL_NAME_CHECKER':
      logger.info('Using DclNameChecker + ACL')
      return createDclNamePlusACLPermissionChecker(components)
    case 'ENDPOINT_NAME_CHECKER':
      logger.info('Using Endpoint NameChecker')
      return await createEndpointNameChecker(components)
    case 'NOOP_NAME_CHECKER':
      logger.info('Using NoOp NameChecker')
      return await createNoOpNameChecker()
  }
  throw Error(`Invalid nameValidatorStrategy selected: ${nameValidatorStrategy}`)
}

export async function createDclNamePlusACLPermissionChecker(
  components: Pick<AppComponents, 'logs' | 'dclNameChecker'>
): Promise<IWorldNamePermissionChecker> {
  return {
    checkPermission: async function (ethAddress: EthAddress, worldName: string): Promise<boolean> {
      if (await components.dclNameChecker.checkOwnership(ethAddress, worldName)) {
        return true
      }
      // TODO check ACL
      return false
    },
    validate(_deployment: DeploymentToValidate): Promise<boolean> {
      return Promise.resolve(false)
    }
  }
}

export async function createEndpointNameChecker(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch'>
): Promise<IWorldNamePermissionChecker> {
  const nameCheckUrl = await components.config.requireString('ENDPOINT_NAME_CHECKER_BASE_URL')

  return {
    checkPermission: async (ethAddress: EthAddress, worldName: string): Promise<boolean> => {
      if (worldName.length === 0 || ethAddress.length === 0) {
        return false
      }

      const res = await components.fetch.fetch(nameCheckUrl, {
        method: 'POST',
        body: JSON.stringify({
          worldName: worldName,
          ethAddress: ethAddress
        })
      })

      return res.json()
    },
    validate(_deployment: DeploymentToValidate): Promise<boolean> {
      return Promise.resolve(false)
    }
  }
}

export async function createNoOpNameChecker(): Promise<IWorldNamePermissionChecker> {
  async function checkPermission(ethAddress: EthAddress, worldName: string): Promise<boolean> {
    return !(worldName.length === 0 || ethAddress.length === 0)
  }
  return {
    checkPermission,
    validate(_deployment: DeploymentToValidate): Promise<boolean> {
      return Promise.resolve(true)
    }
  }
}
