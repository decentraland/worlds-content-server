import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createValidator, validateEntity } from '../../src/adapters/validator'
import { MockedStorage } from '@dcl/catalyst-storage/dist/MockedStorage'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { DeploymentToValidate, IDclNameChecker, ILimitsManager } from '../../src/types'
import { HTTPProvider, stringToUtf8Bytes } from 'eth-connect'
import { Entity, EntityType } from '@dcl/schemas'
import { createMockLimitsManagerComponent } from '../mocks/limits-manager-mock'
import { createMockDclNameChecker } from '../mocks/dcl-name-checker-mock'
import { ContentClient, DeploymentBuilder, DeploymentPreparationData } from 'dcl-catalyst-client'
import { getIdentity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV1 } from '@dcl/hashing'
import { TextDecoder } from 'util'

describe('validator', function () {
  let config: IConfigComponent
  let storage: IContentStorageComponent
  let contentClient: ContentClient

  beforeEach(async () => {
    config = await createConfigComponent({
      // MAX_PARCELS: '4',
      // MAX_SIZE: '200',
      // ALLOW_SDK6: 'false',
      // WHITELIST_URL: 'http://localhost/whitelist.json',
      HTTP_SERVER_HOST: '0.0.0.0',
      HTTP_SERVER_PORT: '4500',
      DEPLOYMENT_TTL: '10000'
    })
    storage = new MockedStorage()

    contentClient = new ContentClient({
      contentUrl: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber(
        'HTTP_SERVER_PORT'
      )}`
    })
  })

  it('fetches and updates config', async () => {
    const limitsManager: ILimitsManager = createMockLimitsManagerComponent()

    const fetch = {
      fetch: (_url: string, _params: { body?: any; method?: string; mode?: string; headers?: any }): Promise<any> => {
        return Promise.resolve({})
      }
    }
    const ethereumProvider = new HTTPProvider('http://localhost', fetch)

    const dclNameChecker: IDclNameChecker = createMockDclNameChecker()

    const components = {
      config,
      storage,
      limitsManager,
      ethereumProvider,
      dclNameChecker
    }
    const validator = await createValidator(components)

    const identity = await getIdentity()

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt'))

    const sceneJson = {
      type: EntityType.SCENE,
      pointers: ['0,0'],
      timestamp: Date.now(),
      // content: [],
      metadata: {},
      files: entityFiles
    }
    const { files, entityId } = await DeploymentBuilder.buildEntity(sceneJson)
    console.log(files)
    // const entity: Entity = {
    //   version: 'v3',
    //   id: entityId,
    //   content: [],
    //   ...sceneJson
    // }
    const entityFile1 = new TextDecoder().decode(files.get(entityId))
    console.log(entityFile1)
    // const entityId = await hashV1(entityFile)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    const contentHashesInStorage = new Map<string, boolean>()
    contentHashesInStorage.set(fileHash, false)

    const deployment: DeploymentToValidate = {
      entity: JSON.parse(entityFile1),
      files,
      authChain,
      contentHashesInStorage
    }

    const actual = await validateEntity.validate(components, deployment)
    console.log(actual.errors)
    expect(actual.ok()).toBeTruthy()
    const actual1 = await validator.validate(deployment)
    console.log(actual1.errors)
    expect(actual1.ok()).toBeTruthy()
  })
})
