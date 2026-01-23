import { test } from '../components'
import { ContentClient, createContentClient, DeploymentBuilder } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { getIdentity, Identity, makeid, cleanup } from '../utils'
import { defaultAccess } from '../../src/logic/access'

test('DeployEntity POST /entities', function ({ components, stubComponents }) {
  afterEach(async () => {
    jest.resetAllMocks()

    const { storage, database } = components
    await cleanup(storage, database)
  })

  describe('when the user owns the world name', function () {
    let contentClient: ContentClient
    let identity: Identity
    let worldName: string

    beforeEach(async () => {
      const { config, fetch, worldCreator } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      identity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })
    })

    describe('and the entity has minimap and skybox configuration', function () {
      let entityFiles: Map<string, Uint8Array>
      let entityId: string
      let fileHash: string
      let files: Map<string, Uint8Array>

      beforeEach(async () => {
        entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
        fileHash = await hashV1(entityFiles.get('abc.txt')!)

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: ['0,0'],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: worldName,
              miniMapConfig: {
                enabled: true,
                dataImage: 'abc.txt',
                estateImage: 'abc.txt'
              },
              skyboxConfig: {
                textures: ['abc.txt']
              }
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should deploy successfully and return a success message with world access URL', async () => {
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
        const responseBody = await response.json()

        expect(responseBody).toMatchObject({
          message: `Your scene was deployed to World "${worldName}" at parcels: 20,24!\nAccess world: https://play.decentraland.org/?realm=https%3A%2F%2F0.0.0.0%3A3000%2Fworld%2F${worldName}&position=20%2C24`
        })
      })

      it('should store the entity and file content in storage', async () => {
        const { storage } = components
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(await storage.exist(fileHash)).toBe(true)
        expect(await storage.exist(entityId)).toBe(true)
      })

      it('should create world metadata with correct runtime information', async () => {
        const { worldsManager } = components
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        const stored = await worldsManager.getMetadataForWorld(worldName)
        expect(stored).toMatchObject({
          runtimeMetadata: {
            name: worldName,
            entityIds: [entityId],
            minimapDataImage: fileHash,
            minimapEstateImage: fileHash,
            minimapVisible: false,
            skyboxTextures: [fileHash]
          }
        })
      })

      it('should call name permission checker with the correct wallet and world name', async () => {
        const { namePermissionChecker } = stubComponents
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(
          namePermissionChecker.checkPermission.calledWith(identity.authChain.authChain[0].payload, worldName)
        ).toBe(true)
      })

      it('should increment the world deployments counter metric', async () => {
        const { metrics } = stubComponents
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(metrics.increment.calledWithMatch('world_deployments_counter', { kind: 'dcl-name' })).toBe(true)
      })

      it('should publish an SNS message with isMultiplayer set to false', async () => {
        const { snsClient } = stubComponents
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(snsClient.publishMessage.calledOnce).toBe(true)
        const call = snsClient.publishMessage.getCall(0)
        expect(call.args[1]?.isMultiplayer?.StringValue).toBe('false')
      })

      it('should make the world accessible via /world/:world_name/about endpoint', async () => {
        const { localFetch } = components
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        const aboutResponse = await localFetch.fetch(`/world/${worldName}/about`)

        expect(aboutResponse.status).toBe(200)
        const aboutBody = await aboutResponse.json()
        expect(aboutBody).toMatchObject({
          healthy: true,
          acceptingUsers: true,
          spawnCoordinates: '20,24',
          configurations: {
            scenesUrn: expect.arrayContaining([expect.stringContaining(entityId)])
          }
        })
      })

      it('should return the entity in the active entities endpoint', async () => {
        const { localFetch } = components
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        const activeEntitiesResponse = await localFetch.fetch('/entities/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pointers: [worldName] })
        })

        expect(activeEntitiesResponse.status).toBe(200)
        const entities = await activeEntitiesResponse.json()
        expect(entities).toHaveLength(1)
        expect(entities[0]).toMatchObject({ id: entityId })
      })
    })

    describe('and the entity has multiplayerId', function () {
      let entityId: string
      let files: Map<string, Uint8Array>

      beforeEach(async () => {
        const entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: ['0,0'],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '0,0',
              parcels: ['0,0']
            },
            multiplayerId: 'room-123',
            worldConfiguration: {
              name: worldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should publish an SNS message with isMultiplayer set to true', async () => {
        const { snsClient } = stubComponents
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(snsClient.publishMessage.calledOnce).toBe(true)
        const call = snsClient.publishMessage.getCall(0)
        expect(call.args[1]?.isMultiplayer?.StringValue).toBe('true')
      })
    })

    describe('and the world name has uppercase letters', function () {
      let uppercaseWorldName: string
      let entityId: string
      let files: Map<string, Uint8Array>

      beforeEach(async () => {
        const { worldCreator, nameOwnership } = components
        const { namePermissionChecker } = stubComponents

        uppercaseWorldName = worldCreator.randomWorldName().toUpperCase()

        namePermissionChecker.checkPermission
          .withArgs(identity.authChain.authChain[0].payload, uppercaseWorldName)
          .resolves(true)
        nameOwnership.findOwners.mockResolvedValue(
          new Map([[uppercaseWorldName, identity.authChain.authChain[0].payload]])
        )

        const entityFiles = new Map<string, Uint8Array>()
        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: ['0,0'],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: uppercaseWorldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should deploy successfully with uppercase world name', async () => {
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
        const responseBody = await response.json()

        expect(responseBody).toMatchObject({
          message: expect.stringContaining(uppercaseWorldName)
        })
      })

      it('should store the world metadata correctly', async () => {
        const { worldsManager } = components
        const authChain = Authenticator.signPayload(identity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        const stored = await worldsManager.getMetadataForWorld(uppercaseWorldName)
        expect(stored).toMatchObject({
          runtimeMetadata: {
            name: uppercaseWorldName,
            entityIds: [entityId],
            minimapVisible: false
          }
        })
      })
    })
  })

  describe('when the user has deployment permission through allow list', function () {
    let contentClient: ContentClient
    let identity: Identity
    let delegatedIdentity: Identity
    let worldName: string

    beforeEach(async () => {
      const { config, fetch, worldCreator, worldsManager } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents
      const permissions = components.permissions

      identity = await getIdentity()
      delegatedIdentity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      // Create a world entry without deploying a scene
      await worldsManager.storeAccess(worldName, defaultAccess())
      // Grant deployment permission to the delegated identity
      await permissions.grantWorldWidePermission(worldName, 'deployment', [
        delegatedIdentity.realAccount.address.toLowerCase()
      ])

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission
        .withArgs(delegatedIdentity.authChain.authChain[0].payload, worldName)
        .resolves(false)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })
    })

    describe('and the delegated user deploys a scene', function () {
      let entityFiles: Map<string, Uint8Array>
      let entityId: string
      let fileHash: string
      let files: Map<string, Uint8Array>

      beforeEach(async () => {
        entityFiles = new Map<string, Uint8Array>()
        entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
        fileHash = await hashV1(entityFiles.get('abc.txt')!)

        const result = await DeploymentBuilder.buildEntity({
          type: EntityType.SCENE as any,
          pointers: ['0,0'],
          files: entityFiles,
          metadata: {
            main: 'abc.txt',
            scene: {
              base: '20,24',
              parcels: ['20,24']
            },
            worldConfiguration: {
              name: worldName
            }
          }
        })

        entityId = result.entityId
        files = result.files
      })

      it('should deploy successfully', async () => {
        const authChain = Authenticator.signPayload(delegatedIdentity.authChain, entityId)

        const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
        const responseBody = await response.json()

        expect(responseBody).toMatchObject({
          message: expect.stringContaining(worldName)
        })
      })

      it('should store the entity and file content in storage', async () => {
        const { storage } = components
        const authChain = Authenticator.signPayload(delegatedIdentity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(await storage.exist(fileHash)).toBe(true)
        expect(await storage.exist(entityId)).toBe(true)
      })

      it('should preserve the existing permissions', async () => {
        const { worldsManager } = components
        const permissions = components.permissions
        const authChain = Authenticator.signPayload(delegatedIdentity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        const stored = await worldsManager.getMetadataForWorld(worldName)
        expect(stored).toMatchObject({
          runtimeMetadata: {
            entityIds: [entityId],
            minimapVisible: false,
            name: worldName
          }
        })
        // Verify permissions are preserved (now stored in separate table)
        const hasPermission = await permissions.hasWorldWidePermission(
          worldName,
          'deployment',
          delegatedIdentity.realAccount.address.toLowerCase()
        )
        expect(hasPermission).toBe(true)
      })

      it('should increment the world deployments counter metric', async () => {
        const { metrics } = stubComponents
        const authChain = Authenticator.signPayload(delegatedIdentity.authChain, entityId)

        await contentClient.deploy({ files, entityId, authChain })

        expect(metrics.increment.calledWithMatch('world_deployments_counter')).toBe(true)
      })
    })
  })

  describe('when a scene is deployed over an existing scene at the same coordinates', function () {
    let contentClient: ContentClient
    let identity: Identity
    let worldName: string
    let firstEntityId: string
    let secondEntityId: string
    let secondFiles: Map<string, Uint8Array>

    beforeEach(async () => {
      const { config, fetch, worldCreator } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      identity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })

      // Deploy first scene at coordinates 0,0
      const firstEntityFiles = new Map<string, Uint8Array>()
      firstEntityFiles.set('first.txt', stringToUtf8Bytes(makeid(100)))

      const firstResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: firstEntityFiles,
        metadata: {
          main: 'first.txt',
          scene: {
            base: '0,0',
            parcels: ['0,0']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      firstEntityId = firstResult.entityId
      const firstAuthChain = Authenticator.signPayload(identity.authChain, firstEntityId)
      await contentClient.deploy({ files: firstResult.files, entityId: firstEntityId, authChain: firstAuthChain })

      // Prepare second scene at the same coordinates
      const secondEntityFiles = new Map<string, Uint8Array>()
      secondEntityFiles.set('second.txt', stringToUtf8Bytes(makeid(150)))

      const secondResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: secondEntityFiles,
        metadata: {
          main: 'second.txt',
          scene: {
            base: '0,0',
            parcels: ['0,0']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      secondEntityId = secondResult.entityId
      secondFiles = secondResult.files
    })

    it('should replace the first scene with the second scene', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata?.runtimeMetadata.entityIds).toHaveLength(1)
      expect(metadata?.runtimeMetadata.entityIds).toContain(secondEntityId)
      expect(metadata?.runtimeMetadata.entityIds).not.toContain(firstEntityId)
    })

    it('should only return the new scene in the active entities endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      const activeEntitiesResponse = await localFetch.fetch('/entities/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: [worldName] })
      })

      expect(activeEntitiesResponse.status).toBe(200)
      const entities = await activeEntitiesResponse.json()
      expect(entities).toHaveLength(1)
      expect(entities[0]).toMatchObject({ id: secondEntityId })
    })

    it('should list only the new scene in the scenes endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)

      expect(scenesResponse.status).toBe(200)
      const scenesBody = await scenesResponse.json()
      expect(scenesBody.scenes).toHaveLength(1)
      expect(scenesBody.scenes[0]).toMatchObject({
        entityId: secondEntityId,
        parcels: ['0,0']
      })
      expect(scenesBody.total).toBe(1)
    })
  })

  describe('when deploying multiple scenes to the same world at different coordinates', function () {
    let contentClient: ContentClient
    let identity: Identity
    let worldName: string
    let firstEntityId: string
    let secondEntityId: string
    let secondFiles: Map<string, Uint8Array>

    beforeEach(async () => {
      const { config, fetch, worldCreator } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      identity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })

      // Deploy first scene at coordinates 0,0
      const firstEntityFiles = new Map<string, Uint8Array>()
      firstEntityFiles.set('first.txt', stringToUtf8Bytes(makeid(100)))

      const firstResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: firstEntityFiles,
        metadata: {
          main: 'first.txt',
          scene: {
            base: '0,0',
            parcels: ['0,0']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      firstEntityId = firstResult.entityId
      const firstAuthChain = Authenticator.signPayload(identity.authChain, firstEntityId)
      await contentClient.deploy({ files: firstResult.files, entityId: firstEntityId, authChain: firstAuthChain })

      // Prepare second scene at different coordinates
      const secondEntityFiles = new Map<string, Uint8Array>()
      secondEntityFiles.set('second.txt', stringToUtf8Bytes(makeid(150)))

      const secondResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['1,1'],
        files: secondEntityFiles,
        metadata: {
          main: 'second.txt',
          scene: {
            base: '1,1',
            parcels: ['1,1']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      secondEntityId = secondResult.entityId
      secondFiles = secondResult.files
    })

    it('should have both scenes stored in the world', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      // getWorldScenes returns all scenes in the world
      const { scenes, total } = await worldsManager.getWorldScenes({ worldName })
      expect(scenes).toHaveLength(2)
      expect(total).toBe(2)
      expect(scenes.map((s) => s.entityId)).toEqual(expect.arrayContaining([firstEntityId, secondEntityId]))

      // getMetadataForWorld returns the most recently deployed scene
      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata?.runtimeMetadata.entityIds).toHaveLength(1)
      expect(metadata?.runtimeMetadata.entityIds).toContain(secondEntityId) // most recently deployed
    })

    it('should list both scenes in the scenes endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)

      expect(scenesResponse.status).toBe(200)
      const scenesBody = await scenesResponse.json()
      expect(scenesBody.scenes).toHaveLength(2)
      expect(scenesBody.total).toBe(2)
      expect(scenesBody.scenes.map((s: { entityId: string }) => s.entityId)).toEqual(
        expect.arrayContaining([firstEntityId, secondEntityId])
      )
    })

    it('should return the most recently deployed scene in the active entities endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      // Active entities returns one entity per world (the most recently deployed scene)
      const activeEntitiesResponse = await localFetch.fetch('/entities/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: [worldName] })
      })

      expect(activeEntitiesResponse.status).toBe(200)
      const entities = await activeEntitiesResponse.json()
      expect(entities).toHaveLength(1)
      expect(entities[0]).toMatchObject({ id: secondEntityId }) // most recently deployed
    })

    it('should set spawn coordinates to the first deployed scene', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, secondEntityId)

      await contentClient.deploy({ files: secondFiles, entityId: secondEntityId, authChain })

      const settings = await worldsManager.getWorldSettings(worldName)
      expect(settings?.spawnCoordinates).toBe('0,0')
    })
  })

  describe('when the user does not own the requested world name', function () {
    let contentClient: ContentClient
    let identity: Identity
    let worldName: string
    let entityId: string
    let files: Map<string, Uint8Array>
    let fileHash: string

    beforeEach(async () => {
      const { config, fetch, worldCreator } = components
      const { namePermissionChecker } = stubComponents

      identity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(false)

      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
      fileHash = await hashV1(entityFiles.get('abc.txt')!)

      const result = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: entityFiles,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      entityId = result.entityId
      files = result.files
    })

    it('should reject the deployment with a permission error', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
        `Your wallet has no permission to publish this scene because it does not have permission to deploy under \\"${worldName}\\". Check scene.json to select a name that either you own or you were given permission to deploy.`
      )
    })

    it('should not store any files in storage', async () => {
      const { storage } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(await storage.exist(fileHash)).toBe(false)
      expect(await storage.exist(entityId)).toBe(false)
    })

    it('should call name permission checker with the correct wallet and world name', async () => {
      const { namePermissionChecker } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(namePermissionChecker.checkPermission.calledWith(identity.authChain.authChain[0].payload, worldName)).toBe(
        true
      )
    })

    it('should not increment the world deployments counter metric', async () => {
      const { metrics } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(metrics.increment.notCalled).toBe(true)
    })

    it('should not make the world accessible via /world/:world_name/about endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      const aboutResponse = await localFetch.fetch(`/world/${worldName}/about`)
      expect(aboutResponse.status).toBe(404)
    })
  })

  describe('when the entity does not have worldConfiguration', function () {
    let contentClient: ContentClient
    let identity: Identity
    let entityId: string
    let files: Map<string, Uint8Array>
    let fileHash: string

    beforeEach(async () => {
      const { config, fetch } = components

      identity = await getIdentity()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
      fileHash = await hashV1(entityFiles.get('abc.txt')!)

      const result = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: entityFiles,
        metadata: {
          main: 'abc.txt',
          scene: {
            base: '20,24',
            parcels: ['20,24']
          }
        }
      })

      entityId = result.entityId
      files = result.files
    })

    it('should reject the deployment with a validation error', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
        'Deployment failed: scene.json needs to specify a worldConfiguration section with a valid name inside.'
      )
    })

    it('should not store any files in storage', async () => {
      const { storage } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(await storage.exist(fileHash)).toBe(false)
      expect(await storage.exist(entityId)).toBe(false)
    })

    it('should not call name permission checker', async () => {
      const { namePermissionChecker } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(namePermissionChecker.checkPermission.notCalled).toBe(true)
    })

    it('should not increment the world deployments counter metric', async () => {
      const { metrics } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      try {
        await contentClient.deploy({ files, entityId, authChain })
      } catch {
        // Expected to fail
      }

      expect(metrics.increment.notCalled).toBe(true)
    })
  })

  describe('when a scene with multiple parcels is deployed over existing scenes', function () {
    let contentClient: ContentClient
    let identity: Identity
    let worldName: string
    let firstEntityId: string
    let secondEntityId: string
    let thirdEntityId: string
    let thirdFiles: Map<string, Uint8Array>

    beforeEach(async () => {
      const { config, fetch, worldCreator } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      identity = await getIdentity()
      worldName = worldCreator.randomWorldName()

      contentClient = createContentClient({
        url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
        fetcher: fetch
      })

      namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })

      // Deploy first scene at coordinates 0,0
      const firstEntityFiles = new Map<string, Uint8Array>()
      firstEntityFiles.set('first.txt', stringToUtf8Bytes(makeid(100)))

      const firstResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0'],
        files: firstEntityFiles,
        metadata: {
          main: 'first.txt',
          scene: {
            base: '0,0',
            parcels: ['0,0']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      firstEntityId = firstResult.entityId
      const firstAuthChain = Authenticator.signPayload(identity.authChain, firstEntityId)
      await contentClient.deploy({ files: firstResult.files, entityId: firstEntityId, authChain: firstAuthChain })

      // Deploy second scene at coordinates 1,1
      const secondEntityFiles = new Map<string, Uint8Array>()
      secondEntityFiles.set('second.txt', stringToUtf8Bytes(makeid(100)))

      const secondResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['1,1'],
        files: secondEntityFiles,
        metadata: {
          main: 'second.txt',
          scene: {
            base: '1,1',
            parcels: ['1,1']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      secondEntityId = secondResult.entityId
      const secondAuthChain = Authenticator.signPayload(identity.authChain, secondEntityId)
      await contentClient.deploy({ files: secondResult.files, entityId: secondEntityId, authChain: secondAuthChain })

      // Prepare third scene that covers both 0,0 and 1,1
      const thirdEntityFiles = new Map<string, Uint8Array>()
      thirdEntityFiles.set('third.txt', stringToUtf8Bytes(makeid(200)))

      const thirdResult = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['0,0', '1,1'],
        files: thirdEntityFiles,
        metadata: {
          main: 'third.txt',
          scene: {
            base: '0,0',
            parcels: ['0,0', '1,1']
          },
          worldConfiguration: {
            name: worldName
          }
        }
      })

      thirdEntityId = thirdResult.entityId
      thirdFiles = thirdResult.files
    })

    it('should replace both existing scenes with the new multi-parcel scene', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, thirdEntityId)

      await contentClient.deploy({ files: thirdFiles, entityId: thirdEntityId, authChain })

      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata?.runtimeMetadata.entityIds).toHaveLength(1)
      expect(metadata?.runtimeMetadata.entityIds).toContain(thirdEntityId)
      expect(metadata?.runtimeMetadata.entityIds).not.toContain(firstEntityId)
      expect(metadata?.runtimeMetadata.entityIds).not.toContain(secondEntityId)
    })

    it('should list only the new scene in the scenes endpoint', async () => {
      const { localFetch } = components
      const authChain = Authenticator.signPayload(identity.authChain, thirdEntityId)

      await contentClient.deploy({ files: thirdFiles, entityId: thirdEntityId, authChain })

      const scenesResponse = await localFetch.fetch(`/world/${worldName}/scenes`)

      expect(scenesResponse.status).toBe(200)
      const scenesBody = await scenesResponse.json()
      expect(scenesBody.scenes).toHaveLength(1)
      expect(scenesBody.scenes[0]).toMatchObject({
        entityId: thirdEntityId,
        parcels: expect.arrayContaining(['0,0', '1,1'])
      })
      expect(scenesBody.total).toBe(1)
    })
  })
})
