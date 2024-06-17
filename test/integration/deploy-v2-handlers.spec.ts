import { test } from '../components'
import { ContentClient, createContentClient, DeploymentBuilder } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import Sinon from 'sinon'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'
import { getIdentity, Identity, makeid } from '../utils'
import { IWorldCreator, IWorldsManager } from '../../src/types'
import { IContentStorageComponent } from '@dcl/catalyst-storage'

test('deployment v2 works', function ({ components, stubComponents }) {
  let contentClient: ContentClient
  let identity: Identity
  let worldName: string
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager
  let storage: IContentStorageComponent

  const entityFiles = new Map<string, Uint8Array>()

  beforeEach(async () => {
    const { config } = components

    worldCreator = components.worldCreator
    worldsManager = components.worldsManager
    storage = components.storage

    identity = await getIdentity()
    worldName = components.worldCreator.randomWorldName()

    contentClient = createContentClient({
      url: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber('HTTP_SERVER_PORT')}`,
      fetcher: components.fetch
    })

    stubComponents.namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload, worldName)
      .resolves(true)
    stubComponents.nameOwnership.findOwners
      .withArgs([worldName])
      .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
    stubComponents.metrics.increment.withArgs('world_deployments_counter', { kind: 'dcl-name' })
  })

  it('creates an entity and deploys it (owner)', async () => {
    const { storage, worldsManager } = components
    const { snsClient } = stubComponents

    entityFiles.set('abc.txt', stringToUtf8Bytes(makeid(100)))
    const fileHash = await hashV1(entityFiles.get('abc.txt')!)

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

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    snsClient.publish.resolves({
      MessageId: 'mocked-message-id',
      SequenceNumber: 'mocked-sequence-number',
      $metadata: {}
    })

    const response = (await contentClient.deploy({ files, entityId, authChain })) as Response
    expect(await response.json()).toMatchObject({
      message: `Your scene was deployed to a Worlds Content Server!\nAccess world ${worldName}: https://play.decentraland.org/?realm=https%3A%2F%2F0.0.0.0%3A3000%2Fworld%2F${worldName}`
    })

    Sinon.assert.calledWith(
      stubComponents.namePermissionChecker.checkPermission,
      identity.authChain.authChain[0].payload,
      worldName
    )

    expect(await storage.exist(fileHash)).toBeTruthy()
    expect(await storage.exist(entityId)).toBeTruthy()

    const stored = await worldsManager.getMetadataForWorld(worldName)
    expect(stored).toMatchObject({
      entityId,
      runtimeMetadata: {
        name: worldName,
        entityIds: [entityId],
        minimapDataImage: fileHash,
        minimapEstateImage: fileHash,
        minimapVisible: false,
        skyboxTextures: [fileHash]
      }
    })

    Sinon.assert.calledWithMatch(stubComponents.metrics.increment, 'world_deployments_counter', { kind: 'dcl-name' })
  })
})
