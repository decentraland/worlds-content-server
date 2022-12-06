import { test } from '../components'
import { ContentClient } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import Sinon from 'sinon'
import { stringToUtf8Bytes } from 'eth-connect'
import { hashV1 } from '@dcl/hashing'

async function getIdentity() {
  const ephemeralIdentity = createUnsafeIdentity()
  const realAccount = createUnsafeIdentity()

  const authChain = await Authenticator.initializeAuthChain(
    realAccount.address,
    ephemeralIdentity,
    10,
    async (message) => {
      return Authenticator.createSignature(realAccount, message)
    }
  )

  return { authChain, realAccount, ephemeralIdentity }
}

test('deployment works', function ({ components, stubComponents }) {
  it('creates an entity and deploys it', async () => {
    const { config, storage } = components
    const { dclNameChecker, metrics } = stubComponents

    const contentClient = new ContentClient({
      contentUrl: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber(
        'HTTP_SERVER_PORT'
      )}`
    })

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt'))

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await contentClient.buildEntity({
      type: EntityType.SCENE,
      pointers: ['0,0'],
      files: entityFiles,
      metadata: {}
    })

    // Sign entity id
    const identity = await getIdentity()

    dclNameChecker.fetchNamesOwnedByAddress
      .withArgs(identity.authChain.authChain[0].payload)
      .resolves(['my-super-name.dcl.eth'])
    dclNameChecker.determineDclNameToUse
      .withArgs(['my-super-name.dcl.eth'], Sinon.match.any)
      .returns('my-super-name.dcl.eth')

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await contentClient.deployEntity({ files, entityId, authChain })

    Sinon.assert.callCount(dclNameChecker.fetchNamesOwnedByAddress, 4)
    Sinon.assert.callCount(dclNameChecker.determineDclNameToUse, 3)

    expect(await storage.exist(fileHash)).toEqual(true)
    expect(await storage.exist(entityId)).toEqual(true)

    Sinon.assert.calledWithMatch(metrics.increment, 'world_deployments_counter')
  })
})

test('deployment works', function ({ components, stubComponents }) {
  it('creates an entity and deploys it using specified name', async () => {
    const { config, storage } = components
    const { dclNameChecker, metrics } = stubComponents

    const contentClient = new ContentClient({
      contentUrl: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber(
        'HTTP_SERVER_PORT'
      )}`
    })

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt'))

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await contentClient.buildEntity({
      type: EntityType.SCENE,
      pointers: ['0,0'],
      files: entityFiles,
      metadata: {
        worldConfiguration: {
          dclName: 'just-do-it.dcl.eth'
        }
      }
    })

    // Sign entity id
    const identity = await getIdentity()

    dclNameChecker.fetchNamesOwnedByAddress
      .withArgs(identity.authChain.authChain[0].payload)
      .resolves(['my-super-name.dcl.eth', 'just-do-it.dcl.eth'])
    dclNameChecker.determineDclNameToUse
      .withArgs(['my-super-name.dcl.eth', 'just-do-it.dcl.eth'], Sinon.match.any)
      .returns('just-do-it.dcl.eth')

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await contentClient.deployEntity({ files, entityId, authChain })

    Sinon.assert.callCount(dclNameChecker.fetchNamesOwnedByAddress, 4)
    Sinon.assert.callCount(dclNameChecker.determineDclNameToUse, 3)

    expect(await storage.exist(fileHash)).toEqual(true)
    expect(await storage.exist(entityId)).toEqual(true)

    Sinon.assert.calledWithMatch(metrics.increment, 'world_deployments_counter')
  })
})

test('deployment with failed validation', function ({ components, stubComponents }) {
  it('does not work because user does not own requested name', async () => {
    const { config, storage } = components
    const { dclNameChecker, metrics } = stubComponents

    const contentClient = new ContentClient({
      contentUrl: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber(
        'HTTP_SERVER_PORT'
      )}`
    })

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt'))

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await contentClient.buildEntity({
      type: EntityType.SCENE,
      pointers: ['0,0'],
      files: entityFiles,
      metadata: {
        worldConfiguration: {
          dclName: 'just-do-it.dcl.eth'
        }
      }
    })

    // Sign entity id
    const identity = await getIdentity()

    dclNameChecker.fetchNamesOwnedByAddress
      .withArgs(identity.authChain.authChain[0].payload)
      .resolves(['my-super-name.dcl.eth'])

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await expect(() => contentClient.deployEntity({ files, entityId, authChain })).rejects.toThrow(
      'Your wallet has no permission to publish to this server because it doesn\'t own Decentraland NAME "just-do-it.dcl.eth".'
    )

    Sinon.assert.callCount(dclNameChecker.fetchNamesOwnedByAddress, 3)
    Sinon.assert.callCount(dclNameChecker.determineDclNameToUse, 2)

    expect(await storage.exist(fileHash)).toEqual(false)
    expect(await storage.exist(entityId)).toEqual(false)

    Sinon.assert.notCalled(metrics.increment)
  })
})

test('deployment with failed validation', function ({ components, stubComponents }) {
  it('does not work because user does not own any names', async () => {
    const { config, storage } = components
    const { dclNameChecker, metrics } = stubComponents

    const contentClient = new ContentClient({
      contentUrl: `http://${await config.requireString('HTTP_SERVER_HOST')}:${await config.requireNumber(
        'HTTP_SERVER_PORT'
      )}`
    })

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('abc.txt', stringToUtf8Bytes('asd'))
    const fileHash = await hashV1(entityFiles.get('abc.txt'))

    expect(await storage.exist(fileHash)).toEqual(false)

    // Build the entity
    const { files, entityId } = await contentClient.buildEntity({
      type: EntityType.SCENE,
      pointers: ['0,0'],
      files: entityFiles,
      metadata: {}
    })

    // Sign entity id
    const identity = await getIdentity()

    dclNameChecker.fetchNamesOwnedByAddress.withArgs(identity.authChain.authChain[0].payload).resolves([])

    const authChain = Authenticator.signPayload(identity.authChain, entityId)

    // Deploy entity
    await expect(() => contentClient.deployEntity({ files, entityId, authChain })).rejects.toThrow(
      "Your wallet has no permission to publish to this server because it doesn't own a Decentraland NAME."
    )

    Sinon.assert.callCount(dclNameChecker.fetchNamesOwnedByAddress, 3)
    Sinon.assert.callCount(dclNameChecker.determineDclNameToUse, 2)

    expect(await storage.exist(fileHash)).toEqual(false)
    expect(await storage.exist(entityId)).toEqual(false)

    Sinon.assert.notCalled(metrics.increment)
  })
})
