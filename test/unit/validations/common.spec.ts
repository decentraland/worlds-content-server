import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { ILimitsManager, IWorldNamePermissionChecker, IWorldsManager, ValidatorComponents } from '../../../src/types'
import { stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
import { createMockLimitsManagerComponent } from '../../mocks/limits-manager-mock'
import { createMockNamePermissionChecker } from '../../mocks/dcl-name-checker-mock'
import { getIdentity } from '../../utils'
import { Authenticator } from '@dcl/crypto'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV0, hashV1 } from '@dcl/hashing'
import { createWorldsManagerComponent } from '../../../src/adapters/worlds-manager'
import { createLogComponent } from '@well-known-components/logger'
import {
  validateAuthChain,
  validateBaseEntity,
  validateDeploymentTtl,
  validateEntityId,
  validateFiles,
  validateSignature,
  validateSigner
} from '../../../src/logic/validations/common'
import { createDeployment } from './shared'

describe('common validations', function () {
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

  describe('validateEntityId', () => {
    it('with valid entity id', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateEntityId(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with no entity', async () => {
      const deployment = await createDeployment(identity.authChain)

      // make the entity id invalid
      deployment.files.delete(deployment.entity.id)

      const result = await validateEntityId(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(`Entity not found in files.`)
    })

    it('with invalid entity id', async () => {
      const deployment = await createDeployment(identity.authChain)

      // make the entity id invalid
      deployment.files.set(deployment.entity.id, Buffer.from(stringToUtf8Bytes('invalid')))

      const result = await validateEntityId(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors[0]).toContain(
        `Invalid entity hash: expected bafkreihrengxkf4nrevbgosbank2lkmqz525f4z6xis5k5muhvg7mmxtuq but got`
      )
    })
  })

  describe('validateBaseEntity', () => {
    it('with valid entity', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateBaseEntity(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid entity', async () => {
      const deployment = await createDeployment(identity.authChain)

      // make the entity invalid
      delete deployment.entity.type

      const result = await validateBaseEntity(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("must have required property 'type'")
    })
  })

  describe('validateDeploymentTtl', () => {
    it('with valid deployment ttl', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: { worldConfiguration: { name: 'whatever.dcl.eth' } },
        files: []
      })

      const result = await validateDeploymentTtl(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid deployment ttl', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: { worldConfiguration: { name: 'whatever.dcl.eth' } },
        files: []
      })

      const result = await validateDeploymentTtl(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors[0]).toContain('Deployment was created ')
      expect(result.errors[0]).toContain('secs ago. Max allowed: 10 secs.')
    })
  })

  describe('validateAuthChain', () => {
    it('with valid authChain', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateAuthChain(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid authChain', async () => {
      const deployment = await createDeployment(identity.authChain)

      // Alter the authChain to make it fail
      deployment.authChain = []

      const result = await validateAuthChain(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('must NOT have fewer than 1 items')
    })
  })

  describe('validateSigner', () => {
    it('with valid signer', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSigner(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid signer', async () => {
      const deployment = await createDeployment(identity.authChain)

      // Alter the signature to make it fail
      deployment.authChain[0].payload = 'Invalid'

      const result = await validateSigner(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Invalid signer: Invalid')
    })
  })

  describe('validateSignature', () => {
    it('with valid signature', async () => {
      const deployment = await createDeployment(identity.authChain)

      const result = await validateSignature(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid signature', async () => {
      const deployment = await createDeployment(identity.authChain)

      // Alter the signature to make it fail
      deployment.authChain = Authenticator.signPayload(identity.authChain, 'invalidId')

      const result = await validateSignature(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        `ERROR: Invalid final authority. Expected: ${deployment.entity.id}. Current invalidId.`
      )
    })
  })

  describe('validateFiles', () => {
    it('validateFiles OK', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createDeployment(identity.authChain)

      const result = await validateFiles(components, deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('validateFiles with errors', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createDeployment(identity.authChain)

      // Alter the files to make it fail
      deployment.files.set(await hashV1(Buffer.from('efg')), Buffer.from('efg'))
      deployment.files.set(await hashV0(Buffer.from('igh')), Buffer.from('igh'))
      deployment.entity.content.push({
        file: 'def.txt',
        hash: 'bafkreie3yaomoex7orli7fumfwgk5abgels5o5fiauxfijzlzoiymqppdi'
      })

      const result = await validateFiles(components, deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Extra file detected bafkreigu77uot3qljdv2oftqmer2ogd7glvohpolbz3whza6kmzgppmkkm')
      expect(result.errors).toContain(
        'Only CIDv1 are allowed for content files: QmPeE5zaej9HogrHRfS1NejWsTuh4qcFZCc4Q7LMnwdTMK'
      )
      expect(result.errors).toContain(
        "The hashed file doesn't match the provided content: QmPeE5zaej9HogrHRfS1NejWsTuh4qcFZCc4Q7LMnwdTMK"
      )
      expect(result.errors).toContain(
        'The file bafkreie3yaomoex7orli7fumfwgk5abgels5o5fiauxfijzlzoiymqppdi (def.txt) is neither present in the storage or in the provided entity'
      )
    })
  })
})
