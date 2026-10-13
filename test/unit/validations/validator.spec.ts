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
import {
  createDeploymentProcessingMock,
  createStageRecorder,
  StageRecorder
} from '../../mocks/deployment-processing-mock'
import { DeploymentProcessingStage, DeploymentToValidate } from '../../../src/types'

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
      deploymentProcessing: createDeploymentProcessingMock(),
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

  describe('when the scene exceeds its configured parcel limit', () => {
    let namePermissionCheck: jest.Mock
    let parcelPermissionCheck: jest.Mock
    let result: Awaited<ReturnType<ReturnType<typeof createValidator>['validateBeforeStorage']>>

    beforeEach(async () => {
      namePermissionCheck = jest.fn().mockResolvedValue(true)
      parcelPermissionCheck = jest.fn().mockResolvedValue(true)
      const parcels = ['0,0', '1,0', '2,0', '3,0', '4,0']
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: parcels,
        timestamp: Date.now(),
        metadata: {
          main: 'abc.txt',
          scene: { base: '0,0', parcels },
          worldConfiguration: { name: 'whatever.dcl.eth' }
        },
        files: []
      })
      const validator = createValidator({
        ...components,
        namePermissionChecker: { checkPermission: namePermissionCheck } as IWorldNamePermissionChecker,
        permissions: {
          ...permissions,
          hasPermissionForParcels: parcelPermissionCheck
        }
      })

      result = await validator.validateBeforeStorage(deployment)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject the deployment before authorization checks', () => {
      expect(result.errors).toContain('Max allowed scene dimensions is 4 parcels.')
      expect(namePermissionCheck).not.toHaveBeenCalled()
      expect(parcelPermissionCheck).not.toHaveBeenCalled()
    })
  })

  describe('when a signed deployment requires delegated authorization', () => {
    let contentHashCalls: number
    let permissionChecks: jest.Mock
    let result: Awaited<ReturnType<ReturnType<typeof createValidator>['validateBeforeStorage']>>

    beforeEach(async () => {
      contentHashCalls = 0
      permissionChecks = jest.fn().mockResolvedValue(false)
      const deployment = await createSceneDeployment(identity.authChain)
      for (const [hash, file] of deployment.files) {
        if (hash !== deployment.entity.id) {
          file.getHash = async () => {
            contentHashCalls++
            return hash
          }
        }
      }
      const validator = createValidator({
        ...components,
        namePermissionChecker: { checkPermission: permissionChecks } as IWorldNamePermissionChecker,
        permissions: {
          ...permissions,
          hasPermissionForParcels: jest.fn().mockResolvedValue(true)
        }
      })

      result = await validator.validateBeforeStorage(deployment)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should authorize the signer before hashing content files', () => {
      expect({
        contentHashCalls,
        permissionChecks: permissionChecks.mock.calls.length,
        valid: result.ok()
      }).toEqual({ contentHashCalls: 0, permissionChecks: 1, valid: true })
    })
  })

  describe('when the request is aborted while a slow authorization check is running', () => {
    let abortReason: Error
    let caughtError: unknown

    beforeEach(async () => {
      abortReason = new Error('client disconnected')
      const controller = new AbortController()
      const hangingPermissionCheck = jest.fn(() => {
        queueMicrotask(() => controller.abort(abortReason))
        return new Promise<boolean>(() => undefined)
      })
      const deployment = await createSceneDeployment(identity.authChain)
      deployment.signal = controller.signal
      const validator = createValidator({
        ...components,
        namePermissionChecker: { checkPermission: hangingPermissionCheck } as IWorldNamePermissionChecker
      })

      caughtError = await validator.validateBeforeStorage(deployment).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the cancellation reason without waiting for the hung validation', () => {
      expect(caughtError).toBe(abortReason)
    })
  })

  describe('when the processing stages of a validation are tracked', () => {
    let recorder: StageRecorder
    let deployment: DeploymentToValidate
    let hashStages: DeploymentProcessingStage[][]
    let permissionStages: DeploymentProcessingStage[][]
    let deniedNameStages: DeploymentProcessingStage[][]
    let validator: ReturnType<typeof createValidator>

    beforeEach(async () => {
      recorder = createStageRecorder()
      hashStages = []
      permissionStages = []
      deniedNameStages = []
      deployment = await createSceneDeployment(identity.authChain)
      // The entity file is also hashed by the entity id check, outside the hash stage.
      for (const [hash, file] of deployment.files) {
        if (hash === deployment.entity.id) continue
        const getHash = file.getHash
        file.getHash = (signal?: AbortSignal) => {
          hashStages.push(recorder.openStages())
          return getHash(signal)
        }
      }
      validator = createValidator({
        ...components,
        deploymentProcessing: createDeploymentProcessingMock({ trackStage: recorder.trackStage }),
        nameDenyListChecker: {
          checkNameDenyList: jest.fn(async () => {
            deniedNameStages.push(recorder.openStages())
            return true
          })
        } as unknown as INameDenyListChecker,
        namePermissionChecker: {
          checkPermission: jest.fn(async () => {
            permissionStages.push(recorder.openStages())
            return true
          })
        } as unknown as IWorldNamePermissionChecker
      })
    })

    describe('and a staging deployment checks its permission', () => {
      beforeEach(async () => {
        await validator.validateStaging(deployment)
      })

      it('should hash the uploaded content files inside the hash stage', () => {
        expect(hashStages).toEqual([['hash']])
      })

      it('should count the uploaded files as the hash stage items', () => {
        expect(recorder.trackStage).toHaveBeenCalledWith('hash', deployment.files.size, expect.any(Function))
      })

      it('should check the permission inside the permission stage, nested in authorization', () => {
        expect(permissionStages).toEqual([['authorization', 'permission']])
      })

      it('should check banned names inside the authorization stage', () => {
        expect(deniedNameStages).toEqual([['authorization']])
      })
    })

    describe('and a staging deployment skips its permission check', () => {
      beforeEach(async () => {
        await validator.validateStaging(deployment, { skipPermissionCheck: true })
      })

      it('should not open the permission stage', () => {
        expect(recorder.trackStage).not.toHaveBeenCalledWith('permission', expect.anything(), expect.anything())
      })
    })

    describe('and a full deployment is validated', () => {
      beforeEach(async () => {
        await validator.validate(deployment)
      })

      it('should check the permission inside the permission stage, nested in authorization', () => {
        expect(permissionStages).toEqual([['authorization', 'permission']])
      })

      it('should check the size limit inside the limits stage', () => {
        expect(recorder.trackStage).toHaveBeenCalledWith('limits', 1, expect.any(Function))
      })
    })

    describe('and every file was hashed earlier in the request', () => {
      beforeEach(async () => {
        for (const file of deployment.files.values()) file.isHashed = () => true
        await validator.validate(deployment)
      })

      it('should not open the hash stage', () => {
        expect(recorder.trackStage).not.toHaveBeenCalledWith('hash', expect.anything(), expect.anything())
      })
    })

    describe('and only the entity file was hashed earlier in the request', () => {
      beforeEach(async () => {
        deployment.files.get(deployment.entity.id)!.isHashed = () => true
        await validator.validate(deployment)
      })

      it('should count only the files still to hash as the hash stage items', () => {
        expect(recorder.trackStage).toHaveBeenCalledWith('hash', deployment.files.size - 1, expect.any(Function))
      })
    })
  })
})
