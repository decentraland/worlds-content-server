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

  async function countDeployedScenes(): Promise<number> {
    const { database } = components
    const result = await database.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM world_scenes WHERE entity_id = '${entityId}' AND status = 'DEPLOYED'`
    )
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

  describe('when uploading across multiple requests (resume fast-path)', () => {
    it('should run the deployment-permission check only on the first request and at finalize, not per batch', async () => {
      const { namePermissionChecker } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const [hashA, hashB] = contentHashes

      expect((await post(buildForm([entityId], authChain))).status).toBe(202)
      expect((await post(buildForm([hashA], authChain))).status).toBe(202)
      expect((await post(buildForm([hashB], authChain))).status).toBe(200)

      // Request 1 (creates the pending record) runs the permission check; requests 2 and 3 are resume
      // batches by the same deployer that skip it; finalize (inside request 3) re-runs it.
      expect(namePermissionChecker.checkPermission).toHaveBeenCalledTimes(2)
    })

    it('should reject the completing request when the deployer loses the name permission mid-upload', async () => {
      const { namePermissionChecker } = stubComponents
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const [hashA, hashB] = contentHashes

      expect((await post(buildForm([entityId, hashA], authChain))).status).toBe(202)

      // The name is traded away mid-upload: the permission checker resolves the CURRENT owner, which is
      // no longer the deployer. The resume batch itself is accepted for staging (same-deployer fast
      // path), but the finalize step re-runs the full validation and must reject the deploy.
      namePermissionChecker.checkPermission.mockResolvedValue(false)

      const res = await post(buildForm([hashB], authChain))

      expect(res.status).toBe(400)
      expect(await countDeployedScenes()).toBe(0)
    })

    it('should not grant the fast path to a different signer resuming the same entity', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      expect((await post(buildForm([entityId], authChain))).status).toBe(202)

      // Another wallet (no deployment permission for this world) signs the same entity id and tries to
      // continue the upload: it must go through the full staging validation and be rejected.
      const otherIdentity = await getIdentity()
      const otherAuthChain = Authenticator.signPayload(otherIdentity.authChain, entityId)
      const res = await post(buildForm([contentHashes[0]], otherAuthChain))

      expect(res.status).toBe(400)
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

  describe('when staging requests for the same entity run in parallel', () => {
    it('should accept two distinct content batches uploaded concurrently and deploy the world once', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const [hashA, hashB] = contentHashes

      expect((await post(buildForm([entityId], authChain))).status).toBe(202)

      const [resA, resB] = await Promise.all([post(buildForm([hashA], authChain)), post(buildForm([hashB], authChain))])

      const statuses = [resA.status, resB.status].sort()
      expect(statuses.every((status) => status === 200 || status === 202)).toBe(true)
      expect(statuses).toContain(200)
      expect(await countDeployedScenes()).toBe(1)
      expect(await countPending()).toBe(0)
    })

    it('should deploy once when two requests complete the content set at the same time', async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const [hashA, hashB] = contentHashes

      // Stage entity + A, leaving only B missing.
      expect((await post(buildForm([entityId, hashA], authChain))).status).toBe(202)

      // Two identical completing requests (both upload B) race to finalize.
      const [res1, res2] = await Promise.all([post(buildForm([hashB], authChain)), post(buildForm([hashB], authChain))])

      expect([res1.status, res2.status].sort()).toEqual([200, 200])
      expect(await countDeployedScenes()).toBe(1)
      expect(await countPending()).toBe(0)
    })
  })

  // Generic form builder for a second entity (the module-level buildForm is bound to the beforeEach one).
  function makeForm(id: string, fileMap: Map<string, Uint8Array>, keys: string[], authChain: AuthChain): FormData {
    const form = new FormData()
    form.append('entityId', id)
    form.append('partial', 'true')
    authChain.forEach((link, i) => {
      form.append(`authChain[${i}][type]`, link.type)
      form.append(`authChain[${i}][payload]`, link.payload)
      form.append(`authChain[${i}][signature]`, link.signature ?? '')
    })
    for (const key of keys) {
      form.append(key, Buffer.from(fileMap.get(key)!), { filename: key })
    }
    return form
  }

  // Builds a scene for the current world on the given parcels at an explicit timestamp (so two scenes
  // can differ only by timestamp, producing distinct entity ids that order deterministically).
  async function buildScene(pointers: string[], timestamp: number) {
    const sceneFiles = new Map<string, Uint8Array>()
    sceneFiles.set('file1.txt', stringToUtf8Bytes(makeid(100)))
    const built = await DeploymentBuilder.buildEntity({
      type: EntityType.SCENE as any,
      pointers,
      files: sceneFiles,
      timestamp,
      metadata: {
        main: 'file1.txt',
        scene: { base: pointers[0], parcels: pointers },
        worldConfiguration: { name: worldName }
      }
    })
    return {
      entityId: built.entityId,
      files: built.files,
      contentHashes: Array.from(built.files.keys()).filter((k) => k !== built.entityId)
    }
  }

  async function deployedEntityIds(): Promise<string[]> {
    const { database } = components
    const result = await database.query<{ entity_id: string }>(
      `SELECT entity_id FROM world_scenes WHERE world_name = '${worldName.toLowerCase()}' AND status = 'DEPLOYED'`
    )
    return result.rows.map((r) => r.entity_id)
  }

  describe('when a stale pending upload would finalize over a newer deployment', () => {
    let older: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let newer: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let completeResponse: Response

    beforeEach(async () => {
      const now = Date.now()
      older = await buildScene(['20,24'], now - 60_000)
      newer = await buildScene(['20,24'], now)

      // Stage the older scene partially (entity only) — no newer scene exists yet, so this is accepted.
      const olderAuth = Authenticator.signPayload(identity.authChain, older.entityId)
      const stageOlder = await post(makeForm(older.entityId, older.files, [older.entityId], olderAuth))
      expect(stageOlder.status).toBe(202)

      // A newer scene is then deployed on the same parcels via a normal single-request deploy.
      const newerAuth = Authenticator.signPayload(identity.authChain, newer.entityId)
      const newerForm = new FormData()
      newerForm.append('entityId', newer.entityId)
      newerAuth.forEach((link, i) => {
        newerForm.append(`authChain[${i}][type]`, link.type)
        newerForm.append(`authChain[${i}][payload]`, link.payload)
        newerForm.append(`authChain[${i}][signature]`, link.signature ?? '')
      })
      for (const key of [newer.entityId, ...newer.contentHashes]) {
        newerForm.append(key, Buffer.from(newer.files.get(key)!), { filename: key })
      }
      expect((await post(newerForm)).status).toBe(200)

      // Now the stalled client completes the older upload.
      completeResponse = (await post(
        makeForm(older.entityId, older.files, older.contentHashes, olderAuth)
      )) as unknown as Response
    })

    it('should reject the stale finalize', () => {
      expect(completeResponse.status).toBe(400)
    })

    it('should keep the newer scene deployed and not install the older one', async () => {
      const deployed = await deployedEntityIds()
      expect(deployed).toEqual([newer.entityId])
    })
  })

  describe('when an over-budget partial request targets parcels held by another pending upload', () => {
    let overBudgetResponse: Response

    beforeEach(async () => {
      // Shrink the world budget so any real content exceeds it.
      jest.spyOn(components.limitsManager, 'getMaxAllowedSizeInBytesFor').mockResolvedValue(1n)

      // Stage upload A (entity only, zero content bytes so far) — passes the 1-byte budget.
      const aAuth = Authenticator.signPayload(identity.authChain, entityId)
      expect((await post(buildForm([entityId], aAuth))).status).toBe(202)

      // Upload B (a different entity on the same parcels) sends real content in one request; it is over
      // budget and must be rejected WITHOUT destroying A's pending row.
      const b = await buildScene(['20,24'], Date.now() + 1000)
      const bAuth = Authenticator.signPayload(identity.authChain, b.entityId)
      overBudgetResponse = (await post(
        makeForm(b.entityId, b.files, [b.entityId, ...b.contentHashes], bAuth)
      )) as unknown as Response
    })

    it('should reject the over-budget request', () => {
      expect(overBudgetResponse.status).toBe(400)
    })

    it("should preserve the other deployer's in-flight pending upload", async () => {
      expect(await countPending()).toBe(1)
    })
  })
})
