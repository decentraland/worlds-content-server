import { test } from '../components'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { AuthChain, EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { getIdentity, Identity, makeid, cleanup } from '../utils'
import FormData from 'form-data'

// Lower the per-deployer concurrent-pending cap so it's exercisable without staging 10+ uploads.
// Runs at module evaluation, before the test harness initializes components in beforeAll, and
// process.env wins over .env.default in env-config-provider.
process.env.MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER = '3'

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
    let authChain: AuthChain

    beforeEach(() => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
    })

    describe('and each content file is uploaded in its own batch', () => {
      let hash1: string
      let hash2: string
      let firstResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        ;[hash1, hash2] = contentHashes
        firstResponse = await post(buildForm([entityId], authChain))
      })

      it('should respond 202 with both content hashes missing', async () => {
        expect(firstResponse.status).toBe(202)
        expect(new Set((await firstResponse.json()).missing)).toEqual(new Set([hash1, hash2]))
      })

      it('should create a pending row without making the world live yet', async () => {
        expect(await countPending()).toBe(1)
        expect(await components.worldsManager.getMetadataForWorld(worldName)).toBeUndefined()
      })

      describe('and the second batch uploads the first content file', () => {
        let secondResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          secondResponse = await post(buildForm([hash1], authChain))
        })

        it('should respond 202 with only the remaining hash missing', async () => {
          expect(secondResponse.status).toBe(202)
          expect((await secondResponse.json()).missing).toEqual([hash2])
        })

        describe('and the last batch uploads the remaining content file', () => {
          let thirdResponse: Awaited<ReturnType<typeof post>>

          beforeEach(async () => {
            thirdResponse = await post(buildForm([hash2], authChain))
          })

          it('should finalize with 200 and the deployment message', async () => {
            expect(thirdResponse.status).toBe(200)
            expect((await thirdResponse.json()).message).toContain(`Your scene was deployed to World "${worldName}"`)
          })

          it('should delete the pending row and make the world live', async () => {
            expect(await countPending()).toBe(0)
            expect(await components.worldsManager.getMetadataForWorld(worldName)).toBeDefined()
          })
        })
      })
    })

    describe('and requests after the first omit the entity file', () => {
      let firstResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        firstResponse = await post(buildForm([entityId, contentHashes[0]], authChain))
      })

      it('should accept the first batch with 202', () => {
        expect(firstResponse.status).toBe(202)
      })

      describe('and the remaining content file is uploaded without the entity file', () => {
        let secondResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          // The request omits the entity file; the server reads it back from storage.
          secondResponse = await post(buildForm([contentHashes[1]], authChain))
        })

        it('should finalize with 200 and no pending row', async () => {
          expect(secondResponse.status).toBe(200)
          expect(await countPending()).toBe(0)
        })
      })
    })
  })

  describe('when a single partial request contains all content', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      response = await post(buildForm([entityId, ...contentHashes], authChain))
    })

    it('should finalize immediately and return 200', async () => {
      expect(response.status).toBe(200)
      expect(await countPending()).toBe(0)
      expect(await components.worldsManager.getMetadataForWorld(worldName)).toBeDefined()
    })
  })

  describe('when uploading across multiple requests (resume fast-path)', () => {
    let authChain: AuthChain
    let hashA: string
    let hashB: string

    beforeEach(() => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      ;[hashA, hashB] = contentHashes
    })

    describe('and the same deployer uploads every batch', () => {
      let firstResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        firstResponse = await post(buildForm([entityId], authChain))
      })

      it('should accept the request that creates the pending record with 202', () => {
        expect(firstResponse.status).toBe(202)
      })

      describe('and the first content batch is uploaded', () => {
        let secondResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          secondResponse = await post(buildForm([hashA], authChain))
        })

        it('should accept the resume batch with 202', () => {
          expect(secondResponse.status).toBe(202)
        })

        describe('and the last content batch is uploaded', () => {
          let thirdResponse: Awaited<ReturnType<typeof post>>

          beforeEach(async () => {
            thirdResponse = await post(buildForm([hashB], authChain))
          })

          it('should finalize the upload with 200', () => {
            expect(thirdResponse.status).toBe(200)
          })

          it('should run the deployment-permission check only on the first request and at finalize, not per batch', () => {
            // Request 1 (creates the pending record) runs the permission check; requests 2 and 3 are resume
            // batches by the same deployer that skip it; finalize (inside request 3) re-runs it.
            expect(stubComponents.namePermissionChecker.checkPermission).toHaveBeenCalledTimes(2)
          })
        })
      })
    })

    describe('and the deployer loses the name permission mid-upload', () => {
      let stagingResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        stagingResponse = await post(buildForm([entityId, hashA], authChain))
      })

      it('should accept the staging request with 202', () => {
        expect(stagingResponse.status).toBe(202)
      })

      describe('and the name is traded away before the completing request', () => {
        let completingResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          // The name is traded away mid-upload: the permission checker resolves the CURRENT owner, which is
          // no longer the deployer. The resume batch itself is accepted for staging (same-deployer fast
          // path), but the finalize step re-runs the full validation and must reject the deploy.
          stubComponents.namePermissionChecker.checkPermission.mockResolvedValue(false)

          completingResponse = await post(buildForm([hashB], authChain))
        })

        it('should reject the completing request and not deploy the scene', async () => {
          expect(completingResponse.status).toBe(400)
          expect(await countDeployedScenes()).toBe(0)
        })
      })
    })

    describe('and a different signer resumes the same entity', () => {
      let stagingResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        stagingResponse = await post(buildForm([entityId], authChain))
      })

      it('should accept the staging request with 202', () => {
        expect(stagingResponse.status).toBe(202)
      })

      describe('and another wallet signs the same entity id and continues the upload', () => {
        let resumeResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          // Another wallet (no deployment permission for this world) signs the same entity id and tries to
          // continue the upload: it must go through the full staging validation and be rejected.
          const otherIdentity = await getIdentity()
          const otherAuthChain = Authenticator.signPayload(otherIdentity.authChain, entityId)
          resumeResponse = await post(buildForm([contentHashes[0]], otherAuthChain))
        })

        it('should reject the resume request with 400', () => {
          expect(resumeResponse.status).toBe(400)
        })
      })
    })
  })

  describe('when the same partial request is replayed', () => {
    let firstResponse: Awaited<ReturnType<typeof post>>
    let secondResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      firstResponse = await post(buildForm([entityId], authChain))
      secondResponse = await post(buildForm([entityId], authChain))
    })

    it('should respond 202 to both requests with the same missing hashes', async () => {
      expect(firstResponse.status).toBe(202)
      expect(secondResponse.status).toBe(202)
      expect(new Set((await secondResponse.json()).missing)).toEqual(new Set(contentHashes))
    })

    it('should keep a single pending row', async () => {
      expect(await countPending()).toBe(1)
    })
  })

  describe('when the first partial request omits the entity file', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      response = await post(buildForm([contentHashes[0]], authChain))
    })

    it('should return 400 and not create a pending row', async () => {
      expect(response.status).toBe(400)
      expect(await countPending()).toBe(0)
    })
  })

  describe('when staging requests for the same entity run in parallel', () => {
    let authChain: AuthChain
    let hashA: string
    let hashB: string

    beforeEach(() => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      ;[hashA, hashB] = contentHashes
    })

    describe('and two distinct content batches are uploaded concurrently', () => {
      let stagingResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        stagingResponse = await post(buildForm([entityId], authChain))
      })

      it('should accept the staging request with 202', () => {
        expect(stagingResponse.status).toBe(202)
      })

      describe('and the two remaining batches are sent at the same time', () => {
        let responseA: Awaited<ReturnType<typeof post>>
        let responseB: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          ;[responseA, responseB] = await Promise.all([
            post(buildForm([hashA], authChain)),
            post(buildForm([hashB], authChain))
          ])
        })

        it('should respond to each batch with 200 or 202 and finalize exactly one', () => {
          expect([responseA.status, responseB.status].every((status) => status === 200 || status === 202)).toBe(true)
          expect([responseA.status, responseB.status]).toContain(200)
        })

        it('should deploy the world exactly once with no leftover pending row', async () => {
          expect(await countDeployedScenes()).toBe(1)
          expect(await countPending()).toBe(0)
        })
      })
    })

    describe('and two identical completing requests race to finalize', () => {
      let stagingResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        // Stage entity + A, leaving only B missing.
        stagingResponse = await post(buildForm([entityId, hashA], authChain))
      })

      it('should accept the staging request with 202', () => {
        expect(stagingResponse.status).toBe(202)
      })

      describe('and both completing requests are sent at the same time', () => {
        let firstResponse: Awaited<ReturnType<typeof post>>
        let secondResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          // Two identical completing requests (both upload B) race to finalize.
          ;[firstResponse, secondResponse] = await Promise.all([
            post(buildForm([hashB], authChain)),
            post(buildForm([hashB], authChain))
          ])
        })

        it('should return 200 to both requests', () => {
          expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 200])
        })

        it('should deploy the world exactly once with no leftover pending row', async () => {
          expect(await countDeployedScenes()).toBe(1)
          expect(await countPending()).toBe(0)
        })
      })
    })
  })

  // Generic form builder for a second entity (the module-level buildForm is bound to the beforeEach one).
  function makeForm(
    id: string,
    fileMap: Map<string, Uint8Array>,
    keys: string[],
    authChain: AuthChain,
    partial = true
  ): FormData {
    const form = new FormData()
    form.append('entityId', id)
    if (partial) {
      form.append('partial', 'true')
    }
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
    let olderAuth: AuthChain
    let stageOlderResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const now = Date.now()
      older = await buildScene(['20,24'], now - 60_000)
      newer = await buildScene(['20,24'], now)

      // Stage the older scene partially (entity only) — no newer scene exists yet, so this is accepted.
      olderAuth = Authenticator.signPayload(identity.authChain, older.entityId)
      stageOlderResponse = await post(makeForm(older.entityId, older.files, [older.entityId], olderAuth))
    })

    it('should accept staging the older scene with 202', () => {
      expect(stageOlderResponse.status).toBe(202)
    })

    describe('and a newer scene is then deployed on the same parcels', () => {
      let newerDeployResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        // The newer scene is deployed on the same parcels via a normal single-request deploy.
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
        newerDeployResponse = await post(newerForm)
      })

      it('should deploy the newer scene with 200', () => {
        expect(newerDeployResponse.status).toBe(200)
      })

      describe('and the stalled client completes the older upload', () => {
        let completeResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          completeResponse = await post(makeForm(older.entityId, older.files, older.contentHashes, olderAuth))
        })

        it('should reject the stale finalize', () => {
          expect(completeResponse.status).toBe(400)
        })

        it('should keep the newer scene deployed and not install the older one', async () => {
          expect(await deployedEntityIds()).toEqual([newer.entityId])
        })
      })
    })
  })

  describe('when an over-budget partial request targets parcels held by another pending upload', () => {
    let stagingResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      // Shrink the world budget so any real content exceeds it.
      jest.spyOn(components.limitsManager, 'getMaxAllowedSizeInBytesFor').mockResolvedValue(1n)

      // Stage upload A (entity only, zero content bytes so far) — passes the 1-byte budget.
      const aAuth = Authenticator.signPayload(identity.authChain, entityId)
      stagingResponse = await post(buildForm([entityId], aAuth))
    })

    it('should accept the zero-content staging request with 202', () => {
      expect(stagingResponse.status).toBe(202)
    })

    describe('and a different entity on the same parcels sends over-budget content in one request', () => {
      let overBudgetResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        // Upload B (a different entity on the same parcels) sends real content in one request; it is over
        // budget and must be rejected WITHOUT destroying A's pending row.
        const b = await buildScene(['20,24'], Date.now() + 1000)
        const bAuth = Authenticator.signPayload(identity.authChain, b.entityId)
        overBudgetResponse = await post(makeForm(b.entityId, b.files, [b.entityId, ...b.contentHashes], bAuth))
      })

      it('should reject the over-budget request', () => {
        expect(overBudgetResponse.status).toBe(400)
      })

      it("should preserve the other deployer's in-flight pending upload", async () => {
        expect(await countPending()).toBe(1)
      })
    })
  })

  describe('when a second partial upload targets parcels held by a pending upload', () => {
    let older: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let newer: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let olderAuth: AuthChain
    let newerAuth: AuthChain

    beforeEach(async () => {
      const now = Date.now()
      older = await buildScene(['20,24'], now - 60_000)
      newer = await buildScene(['20,24'], now)
      olderAuth = Authenticator.signPayload(identity.authChain, older.entityId)
      newerAuth = Authenticator.signPayload(identity.authChain, newer.entityId)
    })

    describe('and the incoming upload is newer than the pending one', () => {
      let replaceResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        await post(makeForm(older.entityId, older.files, [older.entityId], olderAuth))
        replaceResponse = await post(makeForm(newer.entityId, newer.files, [newer.entityId], newerAuth))
      })

      it('should accept it and replace the older pending upload', async () => {
        expect(replaceResponse.status).toBe(202)
        expect(await countPending()).toBe(1)
      })

      it('should leave the newer upload as the pending one', async () => {
        const { database } = components
        const result = await database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
        expect(result.rows.map((r) => r.entity_id)).toEqual([newer.entityId])
      })
    })

    describe('and the incoming upload is older than the pending one', () => {
      let rejectResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        await post(makeForm(newer.entityId, newer.files, [newer.entityId], newerAuth))
        rejectResponse = await post(makeForm(older.entityId, older.files, [older.entityId], olderAuth))
      })

      it('should reject the older upload with 400', () => {
        expect(rejectResponse.status).toBe(400)
      })

      it('should keep the newer upload as the sole pending one', async () => {
        const { database } = components
        const result = await database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
        expect(result.rows.map((r) => r.entity_id)).toEqual([newer.entityId])
      })
    })
  })

  describe('when a vanilla deploy targets parcels already held by a newer scene', () => {
    let older: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let newer: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let olderResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const now = Date.now()
      older = await buildScene(['20,24'], now - 60_000)
      newer = await buildScene(['20,24'], now)

      // Deploy the newer scene first (full, single-request vanilla deploy).
      const newerAuth = Authenticator.signPayload(identity.authChain, newer.entityId)
      await post(makeForm(newer.entityId, newer.files, [newer.entityId, ...newer.contentHashes], newerAuth, false))

      // Then a vanilla deploy of the older scene on the same parcels.
      const olderAuth = Authenticator.signPayload(identity.authChain, older.entityId)
      olderResponse = await post(
        makeForm(older.entityId, older.files, [older.entityId, ...older.contentHashes], olderAuth, false)
      )
    })

    it('should reject the older vanilla deploy with 400 (deployScene enforces ordering atomically)', () => {
      expect(olderResponse.status).toBe(400)
    })

    it('should keep the newer scene deployed', async () => {
      expect(await deployedEntityIds()).toEqual([newer.entityId])
    })

    it('should not leave the rejected scene content in storage (rejected before storing)', async () => {
      const stored = await components.storage.existMultiple(older.contentHashes)
      expect([...stored.values()].some((present) => present)).toBe(false)
    })
  })

  describe('when a deployer at the cap replaces one of their own pending uploads with a newer one', () => {
    // Test config sets MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER=3.
    let replaceResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const now = Date.now()
      // Fill the cap: three distinct uploads on disjoint parcels.
      const parcels = [['20,24'], ['20,25'], ['20,26']]
      const scenes = await Promise.all(parcels.map((p) => buildScene(p, now)))
      for (const scene of scenes) {
        const auth = Authenticator.signPayload(identity.authChain, scene.entityId)
        await post(makeForm(scene.entityId, scene.files, [scene.entityId], auth))
      }
      // A newer upload overlapping the first one replaces it — the deployer's row count stays at 3, so
      // the cap must NOT reject it (the decision is the net change, not a stale "is this new?" flag).
      const replacement = await buildScene(['20,24'], now + 1000)
      const replAuth = Authenticator.signPayload(identity.authChain, replacement.entityId)
      replaceResponse = await post(makeForm(replacement.entityId, replacement.files, [replacement.entityId], replAuth))
    })

    it('should accept the replacement with 202 rather than rejecting it as over-cap', () => {
      expect(replaceResponse.status).toBe(202)
    })

    it('should keep the deployer at the cap (net count unchanged)', async () => {
      expect(await countPending()).toBe(3)
    })
  })

  describe('when a deployer exceeds the concurrent-pending upload cap', () => {
    // Test config sets MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER=3.
    let overCapResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      // Stage three distinct uploads (same deployer + world, disjoint parcels so none replace another).
      const parcels = [['20,24'], ['20,25'], ['20,26'], ['20,27']]
      const scenes = await Promise.all(parcels.map((p, i) => buildScene(p, Date.now() + i)))
      for (let i = 0; i < 3; i++) {
        const auth = Authenticator.signPayload(identity.authChain, scenes[i].entityId)
        await post(makeForm(scenes[i].entityId, scenes[i].files, [scenes[i].entityId], auth))
      }
      // The fourth new upload exceeds the cap.
      const fourthAuth = Authenticator.signPayload(identity.authChain, scenes[3].entityId)
      overCapResponse = await post(makeForm(scenes[3].entityId, scenes[3].files, [scenes[3].entityId], fourthAuth))
    })

    it('should reject the upload beyond the cap with 400', () => {
      expect(overCapResponse.status).toBe(400)
    })

    it('should not create a pending row for the rejected upload', async () => {
      expect(await countPending()).toBe(3)
    })
  })
})
