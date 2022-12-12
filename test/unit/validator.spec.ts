import { createConfigComponent } from '@well-known-components/env-config-provider'
import {
  createValidator,
  validateAuthChain,
  validateDclName,
  validateDeploymentTtl,
  validateEntity,
  validateEntityId,
  validateSceneDimensions,
  validateSignature,
  validateSigner
} from '../../src/adapters/validator'
import { MockedStorage } from '@dcl/catalyst-storage/dist/MockedStorage'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { DeploymentToValidate, IDclNameChecker, ILimitsManager, ValidatorComponents } from '../../src/types'
import { HTTPProvider, stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
import { createMockLimitsManagerComponent } from '../mocks/limits-manager-mock'
import { createMockDclNameChecker } from '../mocks/dcl-name-checker-mock'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { getIdentity } from '../utils'
import { Authenticator, AuthIdentity } from '@dcl/crypto'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV1 } from '@dcl/hashing'
import { TextDecoder } from 'util'

describe('validator', function () {
  let config: IConfigComponent
  let storage: IContentStorageComponent
  let ethereumProvider: HTTPProvider
  let fetch
  let limitsManager: ILimitsManager
  let dclNameChecker: IDclNameChecker
  let identity
  let components: ValidatorComponents

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
    fetch = {
      fetch: (_url: string, _params: { body?: any; method?: string; mode?: string; headers?: any }): Promise<any> => {
        return Promise.resolve({})
      }
    }

    ethereumProvider = new HTTPProvider('http://localhost', fetch)
    limitsManager = createMockLimitsManagerComponent()
    dclNameChecker = createMockDclNameChecker(['whatever.dcl.eth'])

    identity = await getIdentity()
    components = {
      config,
      storage,
      limitsManager,
      ethereumProvider,
      dclNameChecker
    }
  })

  it('all validations pass', async () => {
    const validator = await createValidator(components)

    const deployment = await createDeployment(identity.authChain)

    const actual1 = await validator.validate(deployment)
    expect(actual1.ok()).toBeTruthy()
    expect(actual1.errors).toEqual([])
  })

  it('validateEntity with invalid entity', async () => {
    const deployment = await createDeployment(identity.authChain)

    // make the entity invalid
    delete deployment.entity.type

    const actual = await validateEntity.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain("must have required property 'type'")
  })

  it('validateEntityId with entity id', async () => {
    const deployment = await createDeployment(identity.authChain)

    // make the entity id invalid
    deployment.entity.id = 'bafkreie3yaomoex7orli7fumfwgk5abgels5o5fiauxfijzlzoiymqppdi'

    const actual = await validateEntityId.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors[0]).toContain(`Invalid entity hash: expected `)
    expect(actual.errors[0]).toContain(`but got bafkreie3yaomoex7orli7fumfwgk5abgels5o5fiauxfijzlzoiymqppdi`)
  })

  it('validateDeploymentTtl with invalid deployment ttl', async () => {
    const deployment = await createDeployment(identity.authChain, {
      type: EntityType.SCENE,
      pointers: ['0,0'],
      timestamp: Date.parse('2022-11-01T00:00:00Z'),
      metadata: {},
      files: []
    })

    const actual = await validateDeploymentTtl.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors[0]).toContain('Deployment was created ')
    expect(actual.errors[0]).toContain('secs ago. Max allowed: 10 secs.')
  })

  it('validateAuthChain with invalid authChain', async () => {
    const deployment = await createDeployment(identity.authChain)

    // Alter the authChain to make it fail
    deployment.authChain = []

    const actual = await validateAuthChain.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain('must NOT have fewer than 1 items')
  })

  it('validateSigner with invalid signer', async () => {
    const deployment = await createDeployment(identity.authChain)

    // Alter the signature to make it fail
    deployment.authChain[0].payload = 'Invalid'

    const actual = await validateSigner.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain('Invalid signer: Invalid')
  })

  it('validateSignature with invalid signature', async () => {
    const deployment = await createDeployment(identity.authChain)

    // Alter the signature to make it fail
    deployment.authChain = Authenticator.signPayload(identity.authChain, 'invalidId')

    const actual = await validateSignature.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain(
      `ERROR: Invalid final authority. Expected: ${deployment.entity.id}. Current invalidId.`
    )
  })

  it('validateDclName with no dcl name', async () => {
    const alteredComponents = {
      ...components,
      dclNameChecker: createMockDclNameChecker()
    }
    const deployment = await createDeployment(identity.authChain)

    const actual = await validateDclName.validate(alteredComponents, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain(
      "Deployment failed: Your wallet has no permission to publish to this server because it doesn't own a Decentraland NAME."
    )
  })

  it('validateDclName with no ownership of requested dcl name', async () => {
    const deployment = await createDeployment(identity.authChain, {
      type: EntityType.SCENE,
      pointers: ['0,0'],
      timestamp: Date.now(),
      metadata: {
        worldConfiguration: {
          dclName: 'different.dcl.eth'
        }
      },
      files: []
    })

    const actual = await validateDclName.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain(
      'Deployment failed: Your wallet has no permission to publish to this server because it doesn\'t own Decentraland NAME "different.dcl.eth". Check scene.json to select a different name.'
    )
  })

  it('validateSceneDimensions with more parcels than allowed', async () => {
    const deployment = await createDeployment(identity.authChain, {
      type: EntityType.SCENE,
      pointers: ['0,0', '0,1', '1,0', '1,1', '1,2'],
      timestamp: Date.now(),
      metadata: {},
      files: []
    })

    const actual = await validateSceneDimensions.validate(components, deployment)
    expect(actual.ok()).toBeFalsy()
    expect(actual.errors).toContain('Max allowed scene dimensions is 4 parcels.')
  })
})

async function createDeployment(identityAuthChain: AuthIdentity, entity?: any) {
  const entityFiles = new Map<string, Uint8Array>()
  entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))
  const fileHash = await hashV1(entityFiles.get('abc.txt'))

  const sceneJson = entity || {
    type: EntityType.SCENE,
    pointers: ['0,0'],
    timestamp: Date.now(),
    metadata: {},
    files: entityFiles
  }
  const { files, entityId } = await DeploymentBuilder.buildEntity(sceneJson)
  // console.log(files)
  files.set(entityId, Buffer.from(files.get(entityId)))

  const authChain = Authenticator.signPayload(identityAuthChain, entityId)

  const contentHashesInStorage = new Map<string, boolean>()
  contentHashesInStorage.set(fileHash, false)

  const finalEntity = {
    id: entityId,
    ...JSON.parse(new TextDecoder().decode(files.get(entityId)))
  }

  const deployment: DeploymentToValidate = {
    entity: finalEntity,
    files,
    authChain,
    contentHashesInStorage
  }
  return deployment
}
