import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  ILimitsManager,
  INameDenyListChecker,
  IWorldNamePermissionChecker,
  IWorldsManager,
  ValidatorComponents
} from '../../../src/types'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity, Identity } from '../../utils'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createSceneDeployment } from './shared'
import { createValidator } from '../../../src/logic/validations'
import { createMockNameDenyListChecker } from '../../mocks/name-deny-list-checker-mock'
import { createWorldsManagerMockComponent } from '../../mocks/worlds-manager-mock'
import { createCoordinatesComponent } from '../../../src/logic/coordinates'
import { createMockedPermissionsComponent } from '../../mocks/permissions-component-mock'
import { IPermissionsComponent } from '../../../src/logic/permissions'

describe('validator', function () {
  let config: IConfigComponent
  let storage: IContentStorageComponent
  let limitsManager: ILimitsManager
  let nameDenyListChecker: INameDenyListChecker
  let worldNamePermissionChecker: IWorldNamePermissionChecker
  let worldsManager: IWorldsManager
  let permissions: jest.Mocked<IPermissionsComponent>
  let identity: Identity
  let components: ValidatorComponents

  beforeEach(async () => {
    config = createConfigComponent({
      DEPLOYMENT_TTL: '10000'
    })

    storage = createInMemoryStorage()
    limitsManager = createMockLimitsManagerComponent()
    nameDenyListChecker = createMockNameDenyListChecker([])
    worldNamePermissionChecker = createMockNamePermissionChecker(['whatever.dcl.eth'])
    const coordinates = createCoordinatesComponent()
    worldsManager = await createWorldsManagerMockComponent({ coordinates, storage })
    permissions = createMockedPermissionsComponent()

    identity = await getIdentity()
    components = {
      config,
      storage,
      limitsManager,
      nameDenyListChecker,
      namePermissionChecker: worldNamePermissionChecker,
      worldsManager,
      permissions
    }
  })

  it('all validations pass for scene', async () => {
    const validator = createValidator(components)

    const deployment = await createSceneDeployment(identity.authChain)

    const result = await validator.validate(deployment)
    expect(result.ok()).toBeTruthy()
    expect(result.errors).toEqual([])
  })
})
