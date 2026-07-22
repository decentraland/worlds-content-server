import { createConfigComponent } from '@well-known-components/env-config-provider'
import { bufferToStream, createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  DeploymentFile,
  DeploymentToValidate,
  ILimitsManager,
  INameDenyListChecker,
  IWorldNamePermissionChecker,
  IWorldsManager,
  Validation,
  ValidatorComponents
} from '../../../src/types'
import { stringToUtf8Bytes } from 'eth-connect'
import { Entity, EntityType } from '@dcl/schemas'
import { Readable } from 'stream'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity, Identity } from '../../utils'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV1 } from '@dcl/hashing'
import { createWorldsManagerMockComponent } from '../../mocks/worlds-manager-mock'
import { createCoordinatesComponent } from '../../../src/logic/coordinates'
import {
  createValidateBannedNames,
  createValidateDeploymentPermission,
  createValidateFileCount,
  createValidateParcelCoordinates,
  createValidateSceneDimensions,
  createValidateScenePointers,
  createValidateSdkVersion,
  createValidateSize,
  calculateDeploymentSizeFromFileInfos,
  validateDeprecatedConfig,
  validateMiniMapImages,
  validateSceneEntity,
  validateSkyboxTextures,
  validateThumbnail
} from '../../../src/logic/validations/scene'
import { createSceneDeployment } from './shared'
import { createMockNameDenyListChecker } from '../../mocks/name-deny-list-checker-mock'
import { createMockedPermissionsComponent } from '../../mocks/permissions-component-mock'
import { IPermissionsComponent } from '../../../src/logic/permissions'

describe('scene validations', function () {
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
    nameDenyListChecker = createMockNameDenyListChecker(['banned'])
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

  describe('when validating the scene entity', () => {
    let deployment: DeploymentToValidate

    describe('and the scene metadata is valid', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateSceneEntity(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and required fields are missing', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.parse('2022-11-01T00:00:00Z'),
          metadata: {
            worldConfiguration: { name: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return errors for the missing main and scene properties', async () => {
        const result = await validateSceneEntity(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain("must have required property 'main'")
        expect(result.errors).toContain("must have required property 'scene'")
      })
    })

    describe('and the worldConfiguration is missing', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.parse('2022-11-01T00:00:00Z'),
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            }
          },
          files: []
        })
      })

      it('should return an error requiring a worldConfiguration with a name', async () => {
        const result = await validateSceneEntity(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          'scene.json needs to specify a worldConfiguration section with a valid name inside.'
        )
      })
    })
  })

  describe('when validating the scene pointers', () => {
    let deployment: DeploymentToValidate

    describe('and the pointers match the scene parcels', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['1,2', '1,3'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '1,2', parcels: ['1,2', '1,3'] },
            worldConfiguration: { name: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return a successful result', async () => {
        const result = await createValidateScenePointers(components)(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the pointers match the scene parcels in a different order', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['1,3', '1,2'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '1,2', parcels: ['1,2', '1,3'] },
            worldConfiguration: { name: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return a successful result', async () => {
        const result = await createValidateScenePointers(components)(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the pointers and scene parcels are equivalent but not in canonical form', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['00,00'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '0,0', parcels: ['0,0'] },
            worldConfiguration: { name: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return a successful result', async () => {
        const result = await createValidateScenePointers(components)(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the pointers and scene parcels reference different parcels', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: { base: '100,100', parcels: ['100,100'] },
            worldConfiguration: { name: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return an error requiring the pointers to match the scene parcels', async () => {
        const result = await createValidateScenePointers(components)(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain('The scene pointers [0,0] must match the scene parcels [100,100].')
      })
    })
  })

  describe('when validating the deprecated config', () => {
    let deployment: DeploymentToValidate

    describe('and there are no deprecated fields', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateDeprecatedConfig(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the worldConfiguration uses the deprecated dclName field', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.parse('2022-11-01T00:00:00Z'),
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: { dclName: 'whatever.dcl.eth' }
          },
          files: []
        })
      })

      it('should return an error explaining the field was renamed to name', async () => {
        const result = await validateDeprecatedConfig(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          '`dclName` in scene.json was renamed to `name`. Please update your scene.json accordingly.'
        )
      })
    })

    describe('and the worldConfiguration uses the deprecated minimapVisible field', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.parse('2022-11-01T00:00:00Z'),
          metadata: {
            worldConfiguration: { name: 'whatever.dcl.eth', minimapVisible: true }
          },
          files: []
        })
      })

      it('should return an error pointing to the miniMapConfig replacement', async () => {
        const result = await validateDeprecatedConfig(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          '`minimapVisible` in scene.json is deprecated in favor of `{ miniMapConfig: { visible } }`. Please update your scene.json accordingly.'
        )
      })
    })

    describe('and the worldConfiguration uses the deprecated skybox field', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.parse('2022-11-01T00:00:00Z'),
          metadata: {
            worldConfiguration: { name: 'whatever.dcl.eth', skybox: 3600 }
          },
          files: []
        })
      })

      it('should return an error pointing to the skyboxConfig replacement', async () => {
        const result = await validateDeprecatedConfig(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          '`skybox` in scene.json is deprecated in favor of `{ "skyboxConfig": { "fixedTime": 36000 }}`. Please update your scene.json accordingly.'
        )
      })
    })
  })

  describe('when validating banned names', () => {
    let validateBannedNames: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateBannedNames = createValidateBannedNames(components)
    })

    describe('and the world name is not banned', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateBannedNames(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the world name is banned', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            worldConfiguration: {
              name: 'banned.dcl.eth'
            }
          },
          files: []
        })
      })

      it('should return an error stating the name is in the deny list', async () => {
        const result = await validateBannedNames(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          `Deployment failed: World "banned.dcl.eth" can not be deployed because the name is in the name deny list managed by Decentraland DAO.`
        )
      })
    })
  })

  describe('when validating the deployment permission', () => {
    let validateDeploymentPermission: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateDeploymentPermission = createValidateDeploymentPermission(components)
    })

    describe('and the wallet owns the world name', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateDeploymentPermission(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the wallet does not own the requested name', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            worldConfiguration: {
              name: 'different.dcl.eth'
            }
          },
          files: []
        })
      })

      it('should return a permission error', async () => {
        const result = await validateDeploymentPermission(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          'Deployment failed: Your wallet has no permission to publish this scene because it does not have permission to deploy under "different.dcl.eth". Check scene.json to select a name that either you own or you were given permission to deploy.'
        )
      })
    })

    describe('and the wallet lacks permission over the parcels being deployed', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['100,100'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '100,100',
              parcels: ['100,100']
            },
            worldConfiguration: {
              name: 'different.dcl.eth'
            }
          },
          files: []
        })

        // The wallet only has deployment permission over '0,0', not the requested '100,100',
        // so the deployment (which targets '100,100') is rejected.
        permissions.hasPermissionForParcels.mockImplementation(async (_worldName, _permission, _address, parcels) =>
          parcels.every((parcel) => parcel === '0,0')
        )
      })

      it('should return a permission error', async () => {
        const result = await validateDeploymentPermission(deployment)
        expect(result.ok()).toBeFalsy()
      })
    })
  })

  describe('when validating the scene dimensions', () => {
    let validateSceneDimensions: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateSceneDimensions = createValidateSceneDimensions(components)
    })

    describe('and the scene fits within the parcel limit', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateSceneDimensions(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the scene exceeds the parcel limit', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0', '0,1', '1,0', '1,1', '1,2'],
          timestamp: Date.now(),
          metadata: {
            worldConfiguration: {
              name: 'whatever.dcl.eth'
            }
          },
          files: []
        })
      })

      it('should return an error about the maximum allowed dimensions', async () => {
        const result = await validateSceneDimensions(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain('Max allowed scene dimensions is 4 parcels.')
      })
    })
  })

  describe('when validating the parcel coordinates', () => {
    let validateParcelCoordinates: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateParcelCoordinates = createValidateParcelCoordinates(components)
    })

    describe('and all parcels are within bounds', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateParcelCoordinates(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and a parcel coordinate is out of bounds', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['9999,9999'],
          timestamp: Date.now(),
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '9999,9999',
              parcels: ['9999,9999']
            },
            worldConfiguration: {
              name: 'whatever.dcl.eth'
            }
          },
          files: []
        })
      })

      it('should return an out-of-bounds error', async () => {
        const result = await validateParcelCoordinates(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain('Coordinate X value 9999 is out of bounds. Must be between -150 and 150.')
      })
    })
  })

  describe('when validating the file count', () => {
    let deployment: DeploymentToValidate

    describe('and the file count is within the limit', () => {
      let validateFileCount: Validation

      beforeEach(async () => {
        validateFileCount = createValidateFileCount(components)
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateFileCount(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the file count exceeds the limit', () => {
      let validateFileCount: Validation

      beforeEach(async () => {
        const limitedConfig = createConfigComponent({ MAX_FILE_COUNT: '1' })
        validateFileCount = createValidateFileCount({ config: limitedConfig })

        const files = new Map<string, Uint8Array>()
        files.set('a.txt', Buffer.from(stringToUtf8Bytes('a')))
        files.set('b.txt', Buffer.from(stringToUtf8Bytes('b')))
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            main: 'a.txt',
            scene: {
              base: '0,0',
              parcels: ['0,0']
            },
            worldConfiguration: {
              name: 'whatever.dcl.eth'
            }
          },
          files
        })
      })

      it('should return an error stating the deployment has too many files', async () => {
        const result = await validateFileCount(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors[0]).toContain(
          'The deployment has too many files. The maximum allowed is 1 but the deployment has 2.'
        )
      })
    })
  })

  describe('when validating the deployment size', () => {
    let validateSize: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateSize = createValidateSize(components)
    })

    describe('and the deployment is within the size limit', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateSize(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and stored content metadata was already fetched by the handler', () => {
      let resultOk: boolean
      let retrieveSpy: jest.SpyInstance

      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
        const storedHash = deployment.entity.content[0].hash
        deployment.files.delete(storedHash)
        deployment.contentHashesInStorage.set(storedHash, true)
        deployment.contentFileInfos = new Map([[storedHash, { encoding: null, size: 3, contentSize: 3 }]])
        retrieveSpy = jest.spyOn(storage, 'retrieve')

        resultOk = (await validateSize(deployment)).ok()
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it('should calculate the size without retrieving the content again', () => {
        expect({ resultOk, storageRetrievals: retrieveSpy.mock.calls.length }).toEqual({
          resultOk: true,
          storageRetrievals: 0
        })
      })
    })

    describe('and the deployment exceeds the size limit', () => {
      beforeEach(async () => {
        const fileContent = Buffer.from(
          Array(10 * 1024 * 1024)
            .fill(0)
            .map((_) => Math.floor(Math.random() * 255))
        )
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
        entityFiles.set('file-1.txt', fileContent) // Big file to make validation fail

        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            worldConfiguration: {
              name: 'whatever.dcl.eth'
            }
          },
          files: entityFiles
        })

        // Remove one of the uploaded files and put it directly into storage
        deployment.files.delete(await hashV1(Buffer.from('asd')))
        await storage.storeStream(
          await hashV1(Buffer.from('asd')),
          bufferToStream(Buffer.from(stringToUtf8Bytes('asd')))
        )
      })

      it('should return an error stating the deployment is too big', async () => {
        const result = await validateSize(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          'The deployment is too big. The maximum total size allowed is 10485760 bytes for scenes. You can upload up to 10485760 bytes but you tried to upload 10485763.'
        )
      })
    })
  })

  describe('when validating the SDK version', () => {
    let validateSdkVersion: Validation
    let deployment: DeploymentToValidate

    beforeEach(() => {
      validateSdkVersion = createValidateSdkVersion(components)
    })

    describe('and the scene targets a supported SDK version', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateSdkVersion(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the scene targets an unsupported SDK version', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            runtimeVersion: '6',
            worldConfiguration: {
              name: 'whatever.dcl.eth'
            }
          },
          files: []
        })
      })

      it('should return an error requiring SDK 7', async () => {
        const result = await validateSdkVersion(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          'Worlds are only supported on SDK 7. Please upgrade your scene to latest version of SDK.'
        )
      })
    })
  })

  describe('when validating the minimap images', () => {
    let deployment: DeploymentToValidate

    describe('and the configured minimap images are present', () => {
      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.png', Buffer.from(stringToUtf8Bytes('asd')))

        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            runtimeVersion: '7',
            worldConfiguration: {
              name: 'whatever.dcl.eth',
              miniMapConfig: {
                dataImage: 'abc.png',
                estateImage: 'abc.png'
              }
            }
          },
          files: entityFiles
        })
      })

      it('should return a successful result', async () => {
        const result = await validateMiniMapImages(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and a configured minimap image is missing from the entity', () => {
      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.png', Buffer.from(stringToUtf8Bytes('asd')))

        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            runtimeVersion: '7',
            worldConfiguration: {
              name: 'whatever.dcl.eth',
              miniMapConfig: {
                dataImage: 'abc.png',
                estateImage: 'xyz.png'
              }
            }
          },
          files: entityFiles
        })
      })

      it('should return an error for the missing file', async () => {
        const result = await validateMiniMapImages(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain('The file xyz.png is not present in the entity.')
      })
    })
  })

  describe('when validating the thumbnail', () => {
    let deployment: DeploymentToValidate

    describe('and the thumbnail is a file included in the deployment', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain)
      })

      it('should return a successful result', async () => {
        const result = await validateThumbnail(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and the thumbnail is an absolute URL', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            display: {
              navmapThumbnail: 'https://example.com/image.png'
            }
          }
        })
      })

      it('should return an error requiring the thumbnail to be a deployment file', async () => {
        const result = await validateThumbnail(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain(
          "Scene thumbnail 'https://example.com/image.png' must be a file included in the deployment."
        )
      })
    })

    describe('and the thumbnail file is missing from the deployment', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            display: {
              navmapThumbnail: 'image.png'
            }
          }
        })
      })

      it('should return an error requiring the thumbnail to be a deployment file', async () => {
        const result = await validateThumbnail(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain("Scene thumbnail 'image.png' must be a file included in the deployment.")
      })
    })
  })

  describe('when validating the skybox textures', () => {
    let deployment: DeploymentToValidate

    describe('and the configured textures are present', () => {
      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('xyz.png', Buffer.from(stringToUtf8Bytes('asd')))

        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            runtimeVersion: '7',
            worldConfiguration: {
              name: 'whatever.dcl.eth',
              skyboxConfig: {
                textures: ['xyz.png']
              }
            }
          },
          files: entityFiles
        })
      })

      it('should return a successful result', async () => {
        const result = await validateSkyboxTextures(deployment)
        expect(result.ok()).toBeTruthy()
      })
    })

    describe('and a configured texture is missing from the entity', () => {
      beforeEach(async () => {
        deployment = await createSceneDeployment(identity.authChain, {
          type: EntityType.SCENE,
          pointers: ['0,0'],
          timestamp: Date.now(),
          metadata: {
            runtimeVersion: '7',
            worldConfiguration: {
              name: 'whatever.dcl.eth',
              skyboxConfig: {
                textures: ['xyz.png']
              }
            }
          }
        })
      })

      it('should return an error for the missing texture file', async () => {
        const result = await validateSkyboxTextures(deployment)
        expect(result.ok()).toBeFalsy()
        expect(result.errors).toContain('The texture file xyz.png is not present in the entity.')
      })
    })
  })
})

describe('calculateDeploymentSizeFromFileInfos', () => {
  describe('when content mixes uploaded and stored files with duplicate references', () => {
    let deploymentSize: number

    beforeEach(() => {
      const uploadedHash = 'uploaded-hash'
      const storedHash = 'stored-hash'
      const entity = {
        content: [
          { file: 'uploaded.bin', hash: uploadedHash },
          { file: 'uploaded-copy.bin', hash: uploadedHash },
          { file: 'stored.bin', hash: storedHash },
          { file: 'stored-copy.bin', hash: storedHash }
        ]
      } as Entity
      const uploadedFile: DeploymentFile = {
        asBuffer: async () => Buffer.from('12345'),
        getHash: async () => uploadedHash,
        getStream: () => Readable.from('12345'),
        size: 5
      }

      deploymentSize = calculateDeploymentSizeFromFileInfos(
        entity,
        new Map([[uploadedHash, uploadedFile]]),
        new Map([
          [uploadedHash, undefined],
          [storedHash, { contentSize: 7, encoding: null, size: 7 }]
        ])
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should count each unique hash exactly once using its available size source', () => {
      expect(deploymentSize).toBe(12)
    })
  })

  describe('when referenced content is neither uploaded nor present in the metadata snapshot', () => {
    let caughtError: unknown

    beforeEach(() => {
      const entity = { content: [{ file: 'missing.bin', hash: 'missing-hash' }] } as Entity
      try {
        calculateDeploymentSizeFromFileInfos(entity, new Map(), new Map([['missing-hash', undefined]]))
      } catch (error) {
        caughtError = error
      }
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject the incomplete metadata snapshot', () => {
      expect(caughtError).toEqual(new Error("Couldn't fetch content file with hash missing-hash"))
    })
  })
})
