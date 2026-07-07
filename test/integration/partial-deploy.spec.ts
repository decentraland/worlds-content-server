import { test } from '../components'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { AuthChain, EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { getIdentity, Identity, makeid, cleanup } from '../utils'
import FormData from 'form-data'

test('Partial deployments POST /entities (partial=true)', function ({ components, stubComponents }) {
  let identity: Identity
  let worldName: string
  let entityId: string
  let files: Map<string, Uint8Array>
  let contentHashes: string[]

  afterEach(async () => {
    jest.resetAllMocks()
    const { storage, database } = components
    await cleanup(storage, database)
  })

  function buildForm(keysToInclude: string[], authChain: AuthChain, partial = true): FormData {
    const form = new FormData()
    form.append('entityId', entityId)
    if (partial) {
      form.append('partial', 'true')
    }
    authChain.forEach((link, i) => {
      form.append(`authChain[${i}][type]`, link.type)
      form.append(`authChain[${i}][payload]`, link.payload)
      form.append(`authChain[${i}][signature]`, link.signature ?? '')
    })
    for (const key of keysToInclude) {
      form.append(key, Buffer.from(files.get(key)!), { filename: key })
    }
    return form
  }

  async function post(form: FormData) {
    const { localFetch } = components
    return localFetch.fetch('/entities', {
      method: 'POST',
      headers: form.getHeaders(),
      body: form.getBuffer()
    })
  }

  async function countPending(): Promise<number> {
    const { database } = components
    const result = await database.query<{ count: string }>('SELECT COUNT(*) as count FROM pending_scenes')
    return parseInt(result.rows[0].count)
  }

  beforeEach(async () => {
    const { worldCreator } = components
    const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

    identity = await getIdentity()
    worldName = worldCreator.randomWorldName()

    const entityFiles = new Map<string, Uint8Array>()
    entityFiles.set('file1.txt', stringToUtf8Bytes(makeid(100)))
    entityFiles.set('file2.txt', stringToUtf8Bytes(makeid(120)))

    const result = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers: ['20,24'],
      files: entityFiles,
      metadata: {
        main: 'file1.txt',
        scene: { base: '20,24', parcels: ['20,24'] },
        worldConfiguration: { name: worldName }
      }
    })
    entityId = result.entityId
    files = result.files
    contentHashes = Array.from(files.keys()).filter((k) => k !== entityId)

    namePermissionChecker.checkPermission.mockImplementation(
      async (ethAddress, name) => ethAddress === identity.authChain.authChain[0].payload && name === worldName
    )
    nameOwnership.findOwners.mockImplementation(async (worldNames) =>
      worldNames.length === 1 && worldNames[0] === worldName
        ? new Map([[worldName, identity.authChain.authChain[0].payload]])
        : new Map()
    )
    snsClient.publishMessage.mockResolvedValue({
      MessageId: 'mocked-message-id',
      SequenceNumber: 'mocked-sequence-number',
      $metadata: {}
    })
  })

  describe('when uploading a scene across multiple partial requests', () => {
    it('should return 202 until the last request finalizes with 200 and makes the world live', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const [hash1, hash2] = contentHashes

      const res1 = await post(buildForm([entityId], authChain))
      expect(res1.status).toBe(202)
      expect(new Set((await res1.json()).missing)).toEqual(new Set([hash1, hash2]))
      expect(await countPending()).toBe(1)
      // The world is not live yet.
      expect(await worldsManager.getMetadataForWorld(worldName)).toBeUndefined()

      const res2 = await post(buildForm([hash1], authChain))
      expect(res2.status).toBe(202)
      expect((await res2.json()).missing).toEqual([hash2])

      const res3 = await post(buildForm([hash2], authChain))
      expect(res3.status).toBe(200)
      expect((await res3.json()).message).toContain(`Your scene was deployed to World "${worldName}"`)

      expect(await countPending()).toBe(0)
      expect(await worldsManager.getMetadataForWorld(worldName)).toBeDefined()
    })

    it('should not require the entity file on requests after the first', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      const res1 = await post(buildForm([entityId, contentHashes[0]], authChain))
      expect(res1.status).toBe(202)

      // Second request omits the entity file; the server reads it back from storage.
      const res2 = await post(buildForm([contentHashes[1]], authChain))
      expect(res2.status).toBe(200)
      expect(await countPending()).toBe(0)
    })
  })

  describe('when a single partial request contains all content', () => {
    it('should finalize immediately and return 200', async () => {
      const { worldsManager } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      const res = await post(buildForm([entityId, ...contentHashes], authChain))
      expect(res.status).toBe(200)
      expect(await countPending()).toBe(0)
      expect(await worldsManager.getMetadataForWorld(worldName)).toBeDefined()
    })
  })

  describe('when the same partial request is replayed', () => {
    it('should respond idempotently and keep a single pending row', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      const res1 = await post(buildForm([entityId], authChain))
      const res2 = await post(buildForm([entityId], authChain))

      expect(res1.status).toBe(202)
      expect(res2.status).toBe(202)
      expect(new Set((await res2.json()).missing)).toEqual(new Set(contentHashes))
      expect(await countPending()).toBe(1)
    })
  })

  describe('when the first partial request omits the entity file', () => {
    it('should return 400', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const res = await post(buildForm([contentHashes[0]], authChain))
      expect(res.status).toBe(400)
      expect(await countPending()).toBe(0)
    })
  })
})
