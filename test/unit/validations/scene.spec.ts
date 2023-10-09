import { createConfigComponent } from '@well-known-components/env-config-provider'
import { bufferToStream, createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  ILimitsManager,
  INameDenyListChecker,
  IWorldNamePermissionChecker,
  IWorldsManager,
  ValidatorComponents
} from '../../../src/types'
import { stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity, Identity } from '../../utils'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV1 } from '@dcl/hashing'
import { createWorldsManagerMockComponent } from '../../mocks/worlds-manager-mock'
import {
  createValidateBannedNames,
  createValidateDeploymentPermission,
  createValidateSceneDimensions,
  createValidateSdkVersion,
  createValidateSize,
  validateDeprecatedConfig,
  validateMiniMapImages,
  validateSceneEntity,
  validateSkyboxTextures,
  validateThumbnail
} from '../../../src/logic/validations/scene'
import { createSceneDeployment } from './shared'
import { createMockNameDenyListChecker } from '../../mocks/name-deny-list-checker-mock'

describe('scene validations', function () {
  let config: IConfigComponent
  let storage: IContentStorageComponent
  let limitsManager: ILimitsManager
  let nameDenyListChecker: INameDenyListChecker
  let worldNamePermissionChecker: IWorldNamePermissionChecker
  let worldsManager: IWorldsManager
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
    worldsManager = await createWorldsManagerMockComponent({ storage })

    identity = await getIdentity()
    components = {
      config,
      storage,
      limitsManager,
      nameDenyListChecker,
      namePermissionChecker: worldNamePermissionChecker,
      worldsManager
    }
  })

  describe('validateSceneEntity', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateSceneEntity(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with missing required fields', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {
          worldConfiguration: { name: 'whatever.dcl.eth' }
        },
        files: []
      })

      const result = await validateSceneEntity(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("must have required property 'main'")
      expect(result.errors).toContain("must have required property 'scene'")
    })

    it('with no worldConfiguration', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const result = await validateSceneEntity(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'scene.json needs to specify a worldConfiguration section with a valid name inside.'
      )
    })
  })

  describe('validateDeprecatedConfig', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateSceneEntity(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with old field dclName', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const result = await validateDeprecatedConfig(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        '`dclName` in scene.json was renamed to `name`. Please update your scene.json accordingly.'
      )
    })

    it('with old field minimapVisible', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {
          worldConfiguration: { name: 'whatever.dcl.eth', minimapVisible: true }
        },
        files: []
      })

      const result = await validateDeprecatedConfig(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        '`minimapVisible` in scene.json is deprecated in favor of `{ miniMapConfig: { visible } }`. Please update your scene.json accordingly.'
      )
    })

    it('with old field skybox', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {
          worldConfiguration: { name: 'whatever.dcl.eth', skybox: 3600 }
        },
        files: []
      })

      const result = await validateDeprecatedConfig(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        '`skybox` in scene.json is deprecated in favor of `{ "skyboxConfig": { "fixedTime": 36000 }}`. Please update your scene.json accordingly.'
      )
    })
  })

  describe('validateBannedNames', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const validateBannedNames = createValidateBannedNames(components)
      const result = await validateBannedNames(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with a dcl name that is banned', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const validateBannedNames = createValidateBannedNames(components)
      const result = await validateBannedNames(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        `Deployment failed: World "banned.dcl.eth" can not be deployed because the name is in the name deny list managed by Decentraland DAO.`
      )
    })
  })

  describe('validateDeploymentPermission', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const validateDeploymentPermission = createValidateDeploymentPermission(components)
      const result = await validateDeploymentPermission(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with no ownership of requested dcl name', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const validateDeploymentPermission = createValidateDeploymentPermission(components)
      const result = await validateDeploymentPermission(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'Deployment failed: Your wallet has no permission to publish this scene because it does not have permission to deploy under "different.dcl.eth". Check scene.json to select a name that either you own or you were given permission to deploy.'
      )
    })
  })

  describe('validateSceneDimensions', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const validateSceneDimensions = createValidateSceneDimensions(components)
      const result = await validateSceneDimensions(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with more parcels than allowed', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const validateSceneDimensions = createValidateSceneDimensions(components)
      const result = await validateSceneDimensions(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Max allowed scene dimensions is 4 parcels.')
    })
  })

  describe('validateSize', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const validateSize = createValidateSize(components)
      const result = await validateSize(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const fileContent = Buffer.from(
        Array(10 * 1024 * 1024)
          .fill(0)
          .map((_) => Math.floor(Math.random() * 255))
      )
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
      entityFiles.set('file-1.txt', fileContent) // Big file to make validation fail

      const deployment = await createSceneDeployment(identity.authChain, {
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
      await storage.storeStream(await hashV1(Buffer.from('asd')), bufferToStream(Buffer.from(stringToUtf8Bytes('asd'))))

      const validateSize = createValidateSize(components)
      const result = await validateSize(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'The deployment is too big. The maximum total size allowed is 10485760 bytes for scenes. You can upload up to 10485760 bytes but you tried to upload 10485763.'
      )
    })
  })

  describe('validateSdkVersion', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const validateSdkVersion = createValidateSdkVersion(components)
      const result = await validateSdkVersion(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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

      const validateSdkVersion = createValidateSdkVersion(components)
      const result = await validateSdkVersion(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'Worlds are only supported on SDK 7. Please upgrade your scene to latest version of SDK.'
      )
    })
  })

  describe('validateMiniMapImages', () => {
    it('with all ok', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.png', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createSceneDeployment(identity.authChain, {
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
      const result = await validateMiniMapImages(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.png', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createSceneDeployment(identity.authChain, {
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
      const result = await validateMiniMapImages(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('The file xyz.png is not present in the entity.')
    })
  })

  describe('validateThumbnail', () => {
    it('with all ok', async () => {
      const deployment = await createSceneDeployment(identity.authChain)
      const result = await validateThumbnail(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with absolute URL errors', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: {
          display: {
            navmapThumbnail: 'https://example.com/image.png'
          }
        }
      })
      const result = await validateThumbnail(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        "Scene thumbnail 'https://example.com/image.png' must be a file included in the deployment."
      )
    })

    it('with missing file errors', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: {
          display: {
            navmapThumbnail: 'image.png'
          }
        }
      })
      const result = await validateThumbnail(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("Scene thumbnail 'image.png' must be a file included in the deployment.")
    })
  })

  describe('validateSkyboxTextures', () => {
    it('with all ok', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('xyz.png', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createSceneDeployment(identity.authChain, {
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
      const result = await validateSkyboxTextures(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
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
      const result = await validateSkyboxTextures(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('The texture file xyz.png is not present in the entity.')
    })
  })
})
