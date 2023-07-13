import { createConfigComponent } from '@well-known-components/env-config-provider'
import { ValidatorComponents } from '../../../src/types'
import { stringToUtf8Bytes } from 'eth-connect'
import { EntityType } from '@dcl/schemas'
import { getIdentity, Identity } from '../../utils'
import { Authenticator } from '@dcl/crypto'
import { IConfigComponent } from '@well-known-components/interfaces'
import { hashV0, hashV1 } from '@dcl/hashing'
import {
  createValidateDeploymentTtl,
  validateAuthChain,
  validateBaseEntity,
  validateEntityId,
  validateFiles,
  validateSignature,
  validateSigner,
  validateSupportedEntityType
} from '../../../src/logic/validations/common'
import { createSceneDeployment } from './shared'

describe('common validations', function () {
  let config: IConfigComponent
  let identity: Identity
  let components: Pick<ValidatorComponents, 'config'>

  beforeEach(async () => {
    config = createConfigComponent({
      DEPLOYMENT_TTL: '10000'
    })

    identity = await getIdentity()
    components = {
      config
    }
  })

  describe('validateEntityId', () => {
    it('with valid entity id', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateEntityId(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with no entity', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      // make the entity id invalid
      deployment.files.delete(deployment.entity.id)

      const result = await validateEntityId(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(`Entity not found in files.`)
    })

    it('with invalid entity id', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      // make the entity id invalid
      deployment.files.set(deployment.entity.id, Buffer.from(stringToUtf8Bytes('invalid')))

      const result = await validateEntityId(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors[0]).toContain(
        `Invalid entity hash: expected bafkreihrengxkf4nrevbgosbank2lkmqz525f4z6xis5k5muhvg7mmxtuq but got`
      )
    })
  })

  describe('validateBaseEntity', () => {
    it('with valid entity', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateBaseEntity(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid entity', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: {}
      })

      // make the entity invalid
      deployment.entity.version = 'v2' as any

      const result = await validateBaseEntity(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('must be equal to one of the allowed values')
    })
  })

  describe('validateDeploymentTtl', () => {
    it('with valid deployment ttl', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: { worldConfiguration: { name: 'whatever.dcl.eth' } },
        files: []
      })

      const validateDeploymentTtl = createValidateDeploymentTtl(components)
      const result = await validateDeploymentTtl(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid deployment ttl', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: { worldConfiguration: { name: 'whatever.dcl.eth' } },
        files: []
      })

      const validateDeploymentTtl = createValidateDeploymentTtl(components)
      const result = await validateDeploymentTtl(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors[0]).toContain('Deployment was created ')
      expect(result.errors[0]).toContain('secs ago. Max allowed: 10 secs.')
    })
  })

  describe('validateAuthChain', () => {
    it('with valid authChain', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateAuthChain(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid authChain', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      // Alter the authChain to make it fail
      deployment.authChain = []

      const result = await validateAuthChain(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('must NOT have fewer than 1 items')
    })
  })

  describe('validateSigner', () => {
    it('with valid signer', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateSigner(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid signer', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      // Alter the signature to make it fail
      deployment.authChain[0].payload = 'Invalid'

      const result = await validateSigner(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Invalid signer: Invalid')
    })
  })

  describe('validateSignature', () => {
    it('with valid signature', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateSignature(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with invalid signature', async () => {
      const deployment = await createSceneDeployment(identity.authChain)

      // Alter the signature to make it fail
      deployment.authChain = Authenticator.signPayload(identity.authChain, 'invalidId')

      const result = await validateSignature(deployment)
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

      const deployment = await createSceneDeployment(identity.authChain)

      const result = await validateFiles(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('validateFiles with errors', async () => {
      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', Buffer.from(stringToUtf8Bytes('asd')))

      const deployment = await createSceneDeployment(identity.authChain)

      // Alter the files to make it fail
      deployment.files.set(await hashV1(Buffer.from('efg')), Buffer.from('efg'))
      deployment.files.set(await hashV0(Buffer.from('igh')), Buffer.from('igh'))
      deployment.entity.content.push({
        file: 'def.txt',
        hash: 'bafkreie3yaomoex7orli7fumfwgk5abgels5o5fiauxfijzlzoiymqppdi'
      })

      const result = await validateFiles(deployment)
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

  describe('validateSupportedEntityType', () => {
    it('with valid entity type', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.now(),
        metadata: { worldConfiguration: { name: 'whatever.dcl.eth' } },
        files: []
      })

      const result = await validateSupportedEntityType(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with unsupported entity type', async () => {
      const deployment = await createSceneDeployment(identity.authChain, {
        type: EntityType.PROFILE,
        pointers: ['0x1'],
        timestamp: Date.now(),
        metadata: {},
        files: []
      })

      const result = await validateSupportedEntityType(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Entity type profile is not supported.')
    })
  })
})
