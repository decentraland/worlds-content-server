import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { ILimitsManager, IWorldNamePermissionChecker, IWorldsManager, ValidatorComponents } from '../../../src/types'
import { stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity } from '../../utils'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV1 } from '@dcl/hashing'
import { bufferToStream } from '@dcl/catalyst-storage/dist/content-item'
import { createWorldsManagerComponent } from '../../../src/adapters/worlds-manager'
import { createLogComponent } from '@well-known-components/logger'
import {
  validateDeploymentPermission,
  validateMiniMapImages,
  validateSceneDimensions,
  validateSceneEntity,
  validateSdkVersion,
  validateSize,
  validateSkyboxTextures,
  validateThumbnail
} from '../../../src/logic/validations/scene'
import { createDeployment } from './shared'

describe('scene validations', function () {
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

  describe('validateSceneEntity', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSceneEntity(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with missing required fields', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {
          worldConfiguration: { name: 'whatever.dcl.eth' }
        },
        files: []
      })

      const result = await validateSceneEntity(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("must have required property 'main'")
      expect(result.errors).toContain("must have required property 'scene'")
    })

    it('with old field dclName', async () => {
      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateSceneEntity(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        '`dclName` in scene.json was renamed to `name`. Please update your scene.json accordingly.'
      )
    })

    it('with no worldConfiguration', async () => {
      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateSceneEntity(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'scene.json needs to specify a worldConfiguration section with a valid name inside.'
      )
    })
  })

  describe('validateDeploymentPermission', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateDeploymentPermission(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with no ownership of requested dcl name', async () => {
      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateDeploymentPermission(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'Deployment failed: Your wallet has no permission to publish this scene because it does not have permission to deploy under "different.dcl.eth". Check scene.json to select a name that either you own or you were given permission to deploy.'
      )
    })
  })

  describe('validateSceneDimensions', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSceneDimensions(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with more parcels than allowed', async () => {
      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateSceneDimensions(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Max allowed scene dimensions is 4 parcels.')
    })
  })

  describe('validateSize', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSize(components, deployment)
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

      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateSize(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'The deployment is too big. The maximum total size allowed is 10 MB for scenes. You can upload up to 10485760 bytes but you tried to upload 10485763.'
      )
    })
  })

  describe('validateSdkVersion', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSdkVersion(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const deployment = await createDeployment(identity.authChain, {
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

      const result = await validateSdkVersion(components, deployment)
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

      const deployment = await createDeployment(identity.authChain, {
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
      const result = await validateMiniMapImages(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.png', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createDeployment(identity.authChain, {
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
      const result = await validateMiniMapImages(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('The file xyz.png is not present in the entity.')
    })
  })

  describe('validateThumbnail', () => {
    it('with all ok', async () => {
      const deployment = await createDeployment(identity.authChain)
      const result = await validateThumbnail(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with absolute URL errors', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: {
          display: {
            navmapThumbnail: 'https://example.com/image.png'
          }
        }
      })
      const result = await validateThumbnail(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        "Scene thumbnail 'https://example.com/image.png' must be a file included in the deployment."
      )
    })

    it('with missing file errors', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: {
          display: {
            navmapThumbnail: 'image.png'
          }
        }
      })
      const result = await validateThumbnail(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("Scene thumbnail 'image.png' must be a file included in the deployment.")
    })
  })

  describe('validateSkyboxTextures', () => {
    it('with all ok', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('xyz.png', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createDeployment(identity.authChain, {
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
      const result = await validateSkyboxTextures(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with errors', async () => {
      const deployment = await createDeployment(identity.authChain, {
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
      const result = await validateSkyboxTextures(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('The texture file xyz.png is not present in the entity.')
    })
  })
})