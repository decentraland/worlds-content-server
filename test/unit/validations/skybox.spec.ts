import { EntityType } from '@dcl/schemas'
import { getIdentity, Identity } from '../../utils'
import { createSkyboxDeployment } from './shared'
import { validatePointer, validateSkyboxEntity } from '../../../src/logic/validations/skybox'

describe('skybox validations', function () {
  let identity: Identity

  beforeEach(async () => {
    identity = await getIdentity()
  })

  describe('validateSkyboxEntity', () => {
    it('with all ok', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain)

      const result = await validateSkyboxEntity(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with missing required fields', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain, {
        type: EntityType.SKYBOX,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {},
        files: []
      })

      const result = await validateSkyboxEntity(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain("must have required property 'id'")
      expect(result.errors).toContain("must have required property 'name'")
      expect(result.errors).toContain("must have required property 'unityPackage'")
    })
  })

  describe('validatePointer', () => {
    it('with all ok', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain)

      const result = await validatePointer(deployment)
      expect(result.ok()).toBeTruthy()
    })
    it('with two-word name', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain, {
        type: EntityType.SKYBOX,
        pointers: ['urn:decentraland:skybox:sunny-beach'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {},
        files: []
      })
      const result = await validatePointer(deployment)
      expect(result.ok()).toBeTruthy()
    })

    it('with more than one pointer', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain, {
        type: EntityType.SKYBOX,
        pointers: ['urn:decentraland:skybox:forest', 'urn:decentraland:skybox:beach'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {},
        files: []
      })

      const result = await validatePointer(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain('Skybox should have exactly one pointer.')
    })

    it('with an invalid pointer', async () => {
      const deployment = await createSkyboxDeployment(identity.authChain, {
        type: EntityType.SKYBOX,
        pointers: ['urn:decentraland:skybox:forest:and:more'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: {},
        files: []
      })

      const result = await validatePointer(deployment)
      expect(result.ok()).toBeFalsy()
      expect(result.errors).toContain(
        'Skybox pointer should have 4 parts, start "urn:decentraland.skybox:" and end with a name formed by letters, numbers and "-".'
      )
    })
  })
})
