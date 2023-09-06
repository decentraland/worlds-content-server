import { test } from '../components'
import { createContentClient, DeploymentBuilder } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import Sinon from 'sinon'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { cleanup, getIdentity, storeJson } from '../utils'
import { streamToBuffer } from '@dcl/catalyst-storage'

test('deployment works', function ({ components, stubComponents }) {
  beforeEach(async () => {
    await cleanup(components.storage, components.database)
  })

  it('creates an entity and deploys it (owner)', async () => {
    const { config, storage, worldCreator } = components
    const { namePermissionChecker, metrics } = stubComponents

    const contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt')!)

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const worldName = worldCreator.randomWorldName()
    const { files, entityId } = await DeploymentBuilder.buildEntity({
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

    // Sign entity id
    const identity = await getIdentity()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
    expect(await response.json()).toMatchObject({
      message: `Your scene was deployed to a Worlds Content Server!\nAccess world ${worldName}: https://play.decentraland.org/?realm=https%3A%2F%2F0.0.0.0%3A3000%2Fworld%2F${worldName}`
    })

    Sinon.assert.calledWith(namePermissionChecker.checkPermission, identity.authChain.authChain[0].payload, worldName)

    expect(await storage.exist(fileHash)).toEqual(true)
    expect(await storage.exist(entityId)).toEqual(true)
    expect(await storage.exist(`name-${worldName}`)).toEqual(true)

    const content = await storage.retrieve(`name-${worldName}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      entityId,
      runtimeMetadata: {
        name: worldName,
        entityIds: [entityId],
        minimapDataImage: 'bafkreidiq6d5r7yujricy72476vp4lgfrdmga6pz32edatbgwdfztturyy',
        minimapEstateImage: 'bafkreidiq6d5r7yujricy72476vp4lgfrdmga6pz32edatbgwdfztturyy',
        minimapVisible: false,
        skyboxTextures: ['bafkreidiq6d5r7yujricy72476vp4lgfrdmga6pz32edatbgwdfztturyy']
      }
    })

    Sinon.assert.calledWithMatch(metrics.increment, 'world_deployments_counter')
  })

  it('creates an entity and deploys it (authorized wallet)', async () => {
    const { config, storage, worldCreator, worldsManager } = components
    const { namePermissionChecker, metrics } = stubComponents

    const contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const worldName = worldCreator.randomWorldName()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"]}`

    await worldsManager.storeAcl(worldName, Authenticator.signPayload(ownerIdentity.authChain, payload))

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt')!)
    await storeJson(storage, fileHash, {})

    // Build the entity
    const { files, entityId } = await DeploymentBuilder.buildEntity({
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

    namePermissionChecker.checkPermission
      .withArgs(ownerIdentity.authChain.authChain[0].payload, worldName)
      .resolves(true)
    namePermissionChecker.checkPermission
      .withArgs(delegatedIdentity.authChain.authChain[0].payload, worldName)
      .resolves(false)

    const authChain = Authenticator.signPayload(delegatedIdentity.authChain, entityId)

    // Deploy entity
    await contentClient.deploy({ files, entityId, authChain })

    Sinon.assert.calledWith(
      namePermissionChecker.checkPermission,
      ownerIdentity.authChain.authChain[0].payload,
      worldName
    )

    Sinon.assert.calledWith(
      namePermissionChecker.checkPermission,
      delegatedIdentity.authChain.authChain[0].payload,
      worldName
    )

    expect(await storage.exist(fileHash)).toEqual(true)
    expect(await storage.exist(entityId)).toEqual(true)
    const content = await storage.retrieve(`name-${worldName}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())

    expect(stored).toMatchObject({
      entityId,
      runtimeMetadata: {
        entityIds: [entityId],
        minimapVisible: false,
        name: worldName
      },
      acl: Authenticator.signPayload(ownerIdentity.authChain, payload)
    })

    Sinon.assert.calledWithMatch(metrics.increment, 'world_deployments_counter')
  })

  it('creates an entity and deploys it using uppercase letters in the name', async () => {
    const { config, storage, worldCreator, worldsManager } = components
    const { namePermissionChecker, metrics } = stubComponents

    const contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    const entityFiles = new Map<string, Uint8Array>()

    // Build the entity
    const worldName = worldCreator.randomWorldName().toUpperCase()
    const { files, entityId } = await DeploymentBuilder.buildEntity({
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

    // Sign entity id
    const identity = await getIdentity()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
    expect(await response.json()).toMatchObject({
      message: `Your scene was deployed to a Worlds Content Server!\nAccess world ${worldName}: https://play.decentraland.org/?realm=https%3A%2F%2F0.0.0.0%3A3000%2Fworld%2F${worldName}`
    })

    Sinon.assert.calledWith(namePermissionChecker.checkPermission, identity.authChain.authChain[0].payload, worldName)

    expect(await storage.exist(`name-${worldName.toLowerCase()}`)).toEqual(true)

    const content = await storage.retrieve(`name-${worldName.toLowerCase()}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      entityId,
      runtimeMetadata: {
        name: worldName,
        entityIds: [entityId],
        minimapVisible: false
      }
    })

    const fromDb = await worldsManager.getMetadataForWorld(worldName)
    expect(fromDb).toBeDefined()
    expect(stored).toMatchObject(fromDb)

    Sinon.assert.calledWithMatch(metrics.increment, 'world_deployments_counter')
  })

  it('fails because user does not own requested name', async () => {
    const { config, storage, worldCreator } = components
    const { namePermissionChecker, metrics } = stubComponents

    const contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    const worldName = worldCreator.randomWorldName()

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt')!)

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await DeploymentBuilder.buildEntity({
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

    // Sign entity id
    const identity = await getIdentity()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(false)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
      `Your wallet has no permission to publish this scene because it does not have permission to deploy under \\"${worldName}\\". Check scene.json to select a name that either you own or you were given permission to deploy.`
    )

    Sinon.assert.calledWith(namePermissionChecker.checkPermission, identity.authChain.authChain[0].payload, worldName)

    expect(await storage.exist(fileHash)).toEqual(false)
    expect(await storage.exist(entityId)).toEqual(false)

    Sinon.assert.notCalled(metrics.increment)
  })

  it('fails because user did not specify any names', async () => {
    const { config, storage, worldCreator } = components
    const { namePermissionChecker, metrics } = stubComponents

    const contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    const worldName = worldCreator.randomWorldName()

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt')!)

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await DeploymentBuilder.buildEntity({
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

    // Sign entity id
    const identity = await getIdentity()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(false)

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await expect(() => contentClient.deploy({ files, entityId, authChain })).rejects.toThrow(
      'Deployment failed: scene.json needs to specify a worldConfiguration section with a valid name inside.'
    )

    Sinon.assert.notCalled(namePermissionChecker.checkPermission)

    expect(await storage.exist(fileHash)).toEqual(false)
    expect(await storage.exist(entityId)).toEqual(false)

    Sinon.assert.notCalled(metrics.increment)
  })
})
