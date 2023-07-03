import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { ILimitsManager, IWorldNamePermissionChecker, IWorldsManager, ValidatorComponents } from '../../../src/types'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity } from '../../utils'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createWorldsManagerComponent } from '../../../src/adapters/worlds-manager'
import { createLogComponent } from '@well-known-components/logger'
import { createDeployment } from './shared'
import { createValidator } from '../../../src/logic/validations/validator'

describe('validator', function () {
  let config: IConfigComponent
  let storage: IContentStorageComponent
  let limitsManager: ILimitsManager
  let worldNamePermissionChecker: IWorldNamePermissionChecker
  let worldsManager: IWorldsManager
  let identity
  let components: ValidatorComponents

  beforeEach(async () => {
    config = createConfigComponent({
      DEPLOYMENT_TTL: '10000'
    })
    storage = createInMemoryStorage()
    limitsManager = createMockLimitsManagerComponent()
    worldNamePermissionChecker = createMockNamePermissionChecker(['whatever.dcl.eth'])
    worldsManager = await createWorldsManagerComponent({
      logs: await createLogComponent({ config }),
      storage
    })

    identity = await getIdentity()
    components = {
      config,
      storage,
      limitsManager,
      namePermissionChecker: worldNamePermissionChecker,
      worldsManager
    }
  })

  it('all validations pass', async () => {
    const validator = await createValidator(components)

    const deployment = await createDeployment(identity.authChain)

    const result = await validator.validate(deployment)
    expect(result.ok()).toBeTruthy()
    expect(result.errors).toEqual([])
  })
})
