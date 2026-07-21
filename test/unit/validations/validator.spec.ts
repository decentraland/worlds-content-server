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
import { stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
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
      coordinates,
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

  it('rejects a scene that declares more files than allowed', async () => {
    const validator = createValidator({
      ...components,
      config: createConfigComponent({ DEPLOYMENT_TTL: '10000', MAX_FILE_COUNT: '1' })
    })

    const files = new Map<string, Uint8Array>()
    files.set('a.txt', Buffer.from(stringToUtf8Bytes('a')))
    files.set('b.txt', Buffer.from(stringToUtf8Bytes('b')))
    const deployment = await createSceneDeployment(identity.authChain, {
      type: EntityType.SCENE,
      pointers: ['0,0'],
      timestamp: Date.now(),
      metadata: {
        main: 'a.txt',
        scene: { base: '0,0', parcels: ['0,0'] },
        worldConfiguration: { name: 'whatever.dcl.eth' }
      },
      files
    })

    const result = await validator.validate(deployment)
    expect(result.ok()).toBeFalsy()
    expect(result.errors).toContain(
      'The deployment has too many files. The maximum allowed is 1 but the deployment has 2.'
    )
  })

  describe('when malformed entity content is validated before storage access', () => {
    let result: Awaited<ReturnType<ReturnType<typeof createValidator>['validateBeforeStorage']>>

    beforeEach(async () => {
      const validator = createValidator(components)
      const deployment = await createSceneDeployment(identity.authChain)
      deployment.entity.content = {} as any

      result = await validator.validateBeforeStorage(deployment)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject the malformed content as a validation error', () => {
      expect(result.ok()).toBe(false)
    })
  })

  describe('when the pre-storage file-count limit is exceeded', () => {
    let result: Awaited<ReturnType<ReturnType<typeof createValidator>['validateBeforeStorage']>>

    beforeEach(async () => {
      const validator = createValidator({
        ...components,
        config: createConfigComponent({ DEPLOYMENT_TTL: '10000', MAX_FILE_COUNT: '1' })
      })
      const deployment = await createSceneDeployment(identity.authChain)
      deployment.entity.content!.push({ ...deployment.entity.content![0], file: 'second.txt' })

      result = await validator.validateBeforeStorage(deployment)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject the entity before storage-dependent validation', () => {
      expect(result.errors).toContain(
        'The deployment has too many files. The maximum allowed is 1 but the deployment has 2.'
      )
    })
  })
})
