import { partialDeploymentContract } from '../contracts/partial-deployment'
import { test } from '../components'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { AuthChain, EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { stringToUtf8Bytes } from 'eth-connect'
import { buildDeploymentForm, getIdentity, Identity, makeid, cleanup, signThroughChainOf } from '../utils'
import { MAX_DEPLOYMENT_AUTH_CHAIN_LINKS, MAX_DEPLOYMENT_FIELD_SIZE_IN_BYTES } from '../../src/controllers/multipart'
import FormData from 'form-data'
import { request } from 'http'
import SQL from 'sql-template-strings'

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

  function buildForm(
    keysToInclude: string[],
    authChain: AuthChain,
    partial = true,
    upload: { id: string; files: Map<string, Uint8Array> } = { id: entityId, files }
  ): FormData {
    return buildDeploymentForm(upload.id, authChain, upload.files, keysToInclude, partial)
  }

  async function post(form: FormData, path = '/entities') {
    const { localFetch } = components
    const response = await localFetch.fetch(path, {
      method: 'POST',
      headers: form.getHeaders(),
      body: form.getBuffer()
    })
    // Buffered here so callers that only check the status never leave a response body unconsumed.
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
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

  async function readPublishedSize(): Promise<string | undefined> {
    const { database } = components
    const result = await database.query<{ size: string }>(
      SQL`SELECT size FROM world_scenes WHERE entity_id = ${entityId} AND status = 'DEPLOYED'`
    )
    return result.rows[0]?.size
  }

  async function readAccounting(): Promise<{ reserved: unknown[]; rate: unknown[]; charged: Record<string, boolean> }> {
    const { database } = components
    const reserved = await database.query(SQL`SELECT reserved_bytes FROM pending_scenes WHERE entity_id = ${entityId}`)
    const rate = await database.query('SELECT bytes FROM partial_upload_rates')
    const receipts = await database.query<{ hash: string; charged: boolean }>(
      SQL`SELECT hash, charged FROM pending_scene_files WHERE entity_id = ${entityId}`
    )
    return {
      reserved: reserved.rows,
      rate: rate.rows,
      charged: Object.fromEntries(receipts.rows.map((row) => [row.hash, row.charged]))
    }
  }

  function sizeOf(...keys: string[]): number {
    return keys.reduce((sum, key) => sum + files.get(key)!.byteLength, 0)
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

  partialDeploymentContract(() => ({
    entityId,
    contentHashes,
    send: (keys) => post(buildForm(keys, Authenticator.signPayload(identity.authChain, entityId))),
    sendAsAnotherSigner: async (keys) => {
      const other = await getIdentity()
      return post(buildForm(keys, Authenticator.signPayload(other.authChain, entityId)))
    }
  }))

  describe('when recording progress over several batches', () => {
    let metadataSpy: jest.SpyInstance
    let authChain: AuthChain
    let initialChecks: number
    let middleChecks: number
    let finalChecks: number
    let finalStatus: number
    let deployed: number
    let size: string | undefined
    let storeSpy: jest.SpyInstance
    let finalWrites: string[]

    beforeEach(async () => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      metadataSpy = jest.spyOn(components.storage, 'fileInfo')
      storeSpy = jest.spyOn(components.storage, 'storeStream')
      await post(buildForm([entityId], authChain))
      initialChecks = metadataSpy.mock.calls.length
      metadataSpy.mockClear()
      await post(buildForm([contentHashes[0]], authChain))
      middleChecks = metadataSpy.mock.calls.length
      metadataSpy.mockClear()
      storeSpy.mockClear()
      finalStatus = (await post(buildForm(contentHashes.slice(1), authChain))).status
      finalChecks = metadataSpy.mock.calls.length
      finalWrites = storeSpy.mock.calls.map(([key]) => key).sort()
      deployed = await countDeployedScenes()
      size = await readPublishedSize()
    })

    afterEach(() => {
      metadataSpy.mockRestore()
      storeSpy.mockRestore()
    })

    it('should store only its content and the auth chain on the publishing batch, not the entity file again', () => {
      expect(finalWrites).toEqual([...contentHashes.slice(1), `${entityId}.auth`].sort())
    })

    it('should inventory the storage metadata of every content hash on the first batch', () => {
      expect(initialChecks).toBe(contentHashes.length)
    })

    it('should not probe storage metadata on a middle batch', () => {
      expect(middleChecks).toBe(0)
    })

    it('should not probe storage metadata on the publishing batch', () => {
      expect(finalChecks).toBe(0)
    })

    it('should answer the publishing batch with a success', () => {
      expect(finalStatus).toBe(200)
    })

    it('should deploy the scene once', () => {
      expect(deployed).toBe(1)
    })

    it('should publish the size of its content from the receipts', () => {
      expect(size).toBe(String(sizeOf(...contentHashes)))
    })
  })

  describe('when the first batch fails to store after admission and the upload resumes', () => {
    let authChain: AuthChain
    let failedStatus: number
    let afterFailure: { initialized: unknown[]; stored: Record<string, boolean> }
    let resumeStatus: number
    let resumeMissing: string[]
    let completingStatus: number
    let size: string | undefined

    beforeEach(async () => {
      const { storage, database } = components
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      const storeStream = storage.storeStream.bind(storage)
      // The batch writes its first content file and the entity file but fails on the second content file.
      const storeSpy = jest
        .spyOn(storage, 'storeStream')
        .mockImplementation(async (key, stream, signal) =>
          key === contentHashes[1] ? Promise.reject(new Error('storage unavailable')) : storeStream(key, stream, signal)
        )
      failedStatus = (await post(buildForm([entityId, ...contentHashes], authChain))).status
      storeSpy.mockRestore()
      const initialized = await database.query(
        SQL`SELECT initialized FROM pending_scenes WHERE entity_id = ${entityId}`
      )
      const receipts = await database.query<{ hash: string; stored: boolean }>(
        SQL`SELECT hash, stored FROM pending_scene_files WHERE entity_id = ${entityId}`
      )
      afterFailure = {
        initialized: initialized.rows,
        stored: Object.fromEntries(receipts.rows.map((row) => [row.hash, row.stored]))
      }
      const resume = await post(buildForm([entityId], authChain))
      resumeStatus = resume.status
      resumeMissing = (await resume.json()).missing
      completingStatus = (await post(buildForm([contentHashes[1]], authChain))).status
      size = await readPublishedSize()
    })

    it('should fail the first batch', () => {
      expect(failedStatus).toBe(500)
    })

    it('should leave the upload admitted but uninitialized, with no file recorded as stored', () => {
      expect(afterFailure).toEqual({
        initialized: [{ initialized: false }],
        stored: { [entityId]: false, [contentHashes[0]]: false, [contentHashes[1]]: false }
      })
    })

    it('should request on resume only the content the failed batch did not write', () => {
      expect({ resumeStatus, resumeMissing }).toEqual({ resumeStatus: 202, resumeMissing: [contentHashes[1]] })
    })

    it('should publish once the missing content arrives', () => {
      expect(completingStatus).toBe(200)
    })

    it('should publish the size of its content', () => {
      expect(size).toBe(String(sizeOf(...contentHashes)))
    })
  })

  describe('when an upload re-sends content a deployed scene already references', () => {
    let authChain: AuthChain
    let storeSpy: jest.SpyInstance
    let response: Awaited<ReturnType<typeof post>>
    let body: unknown
    let accounting: unknown

    beforeEach(async () => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      await components.worldCreator.createWorldWithScene({
        files: new Map([['shared.bin', files.get(contentHashes[0])!]])
      })
      storeSpy = jest.spyOn(components.storage, 'storeStream')
      response = await post(buildForm([entityId, contentHashes[0]], authChain))
      body = await response.json()
      accounting = await readAccounting()
    })

    afterEach(() => {
      storeSpy.mockRestore()
    })

    it('should store and charge only the manifest, counting every received byte against the rate', () => {
      expect({ status: response.status, body, stored: storeSpy.mock.calls.map(([hash]) => hash), accounting }).toEqual({
        status: 202,
        body: { missing: [contentHashes[1]] },
        stored: [entityId],
        accounting: {
          reserved: [{ reserved_bytes: String(sizeOf(entityId)) }],
          rate: [{ bytes: String(sizeOf(entityId, contentHashes[0])) }],
          charged: { [entityId]: true, [contentHashes[0]]: false }
        }
      })
    })

    describe('and a later batch re-sends a file an earlier batch stored', () => {
      beforeEach(async () => {
        storeSpy.mockClear()
        response = await post(buildForm([entityId], authChain))
        body = await response.json()
        accounting = await readAccounting()
      })

      it('should neither store nor charge it again', () => {
        expect({ status: response.status, body, stored: storeSpy.mock.calls.length, accounting }).toEqual({
          status: 202,
          body: { missing: [contentHashes[1]] },
          stored: 0,
          accounting: {
            reserved: [{ reserved_bytes: String(sizeOf(entityId)) }],
            rate: [{ bytes: String(sizeOf(entityId, entityId, contentHashes[0])) }],
            charged: { [entityId]: true, [contentHashes[0]]: false }
          }
        })
      })
    })

    describe('and the last batch uploads the remaining content', () => {
      let deployed: number
      let size: string | undefined

      beforeEach(async () => {
        response = await post(buildForm([contentHashes[1]], authChain))
        deployed = await countDeployedScenes()
        size = await readPublishedSize()
      })

      it('should publish the scene sized with the content it found in storage', () => {
        expect({ status: response.status, deployed, size }).toEqual({
          status: 200,
          deployed: 1,
          size: String(sizeOf(...contentHashes))
        })
      })
    })
  })

  describe('when content is in storage only because another pending upload staged it', () => {
    let authChain: AuthChain
    let otherUpload: { id: string; files: Map<string, Uint8Array> }
    let storeSpy: jest.SpyInstance
    let response: Awaited<ReturnType<typeof post>>
    let accounting: unknown

    beforeEach(async () => {
      authChain = Authenticator.signPayload(identity.authChain, entityId)
      const other = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['21,24'],
        files: new Map([
          ['shared.bin', files.get(contentHashes[0])!],
          ['extra.txt', stringToUtf8Bytes(makeid(50))]
        ]),
        metadata: {
          main: 'shared.bin',
          scene: { base: '21,24', parcels: ['21,24'] },
          worldConfiguration: { name: worldName }
        }
      })
      otherUpload = { id: other.entityId, files: other.files }
      await post(
        buildForm(
          [otherUpload.id, contentHashes[0]],
          Authenticator.signPayload(identity.authChain, otherUpload.id),
          true,
          otherUpload
        )
      )
      storeSpy = jest.spyOn(components.storage, 'storeStream')
    })

    afterEach(() => {
      storeSpy.mockRestore()
    })

    // The other upload's bytes share this deployer's rate window, so only the charges are compared.
    async function readCharges(): Promise<unknown> {
      const { reserved, charged } = await readAccounting()
      return { reserved, charged }
    }

    describe('and a new upload lists it in its manifest', () => {
      beforeEach(async () => {
        response = await post(buildForm([entityId], authChain))
        accounting = await readCharges()
      })

      it('should charge it to the new upload', () => {
        expect({ status: response.status, accounting }).toEqual({
          status: 202,
          accounting: {
            reserved: [{ reserved_bytes: String(sizeOf(entityId, contentHashes[0])) }],
            charged: { [entityId]: true, [contentHashes[0]]: true }
          }
        })
      })

      describe('and the upload that staged it expires and is cleaned up', () => {
        let kept: boolean

        beforeEach(async () => {
          await components.database.query(
            SQL`UPDATE pending_scenes SET created_at = now() - interval '2 days' WHERE entity_id = ${otherUpload.id}`
          )
          await components.contentGc.deleteExpiredUploads()
          kept = await components.storage.exist(contentHashes[0])
          accounting = await readCharges()
        })

        it('should keep the content, still charged to the new upload', () => {
          expect({ kept, accounting }).toEqual({
            kept: true,
            accounting: {
              reserved: [{ reserved_bytes: String(sizeOf(entityId, contentHashes[0])) }],
              charged: { [entityId]: true, [contentHashes[0]]: true }
            }
          })
        })
      })
    })

    describe('and a new upload re-sends it', () => {
      beforeEach(async () => {
        response = await post(buildForm([entityId, contentHashes[0]], authChain))
        accounting = await readCharges()
      })

      it('should drop it without storing it again but charge it to the new upload', () => {
        expect({ status: response.status, stored: storeSpy.mock.calls.map(([hash]) => hash), accounting }).toEqual({
          status: 202,
          stored: [entityId],
          accounting: {
            reserved: [{ reserved_bytes: String(sizeOf(entityId, contentHashes[0])) }],
            charged: { [entityId]: true, [contentHashes[0]]: true }
          }
        })
      })
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
          let observe: jest.SpyInstance

          beforeEach(async () => {
            observe = jest.spyOn(components.metrics, 'observe')
            thirdResponse = await post(buildForm([hash2], authChain))
          })

          afterEach(() => {
            observe.mockRestore()
          })

          it('should report that the upload took three batches', () => {
            expect(observe.mock.calls.filter(([name]) => name === 'partial_upload_batches_per_upload')).toEqual([
              ['partial_upload_batches_per_upload', {}, 3]
            ])
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

  describe('when the first batch of an upload takes a while to arrive', () => {
    let sentAt: number
    let status: number | undefined
    let createdAt: Date

    beforeEach(async () => {
      const form = buildForm([entityId, contentHashes[0]], Authenticator.signPayload(identity.authChain, entityId))
      const body = form.getBuffer()
      const port = await components.config.requireNumber('HTTP_SERVER_PORT')
      sentAt = Date.now()
      status = await new Promise<number | undefined>((resolve, reject) => {
        const upload = request(`http://127.0.0.1:${port}/entities`, {
          method: 'POST',
          headers: { ...form.getHeaders(), 'content-length': String(body.length) }
        })
        upload.on('response', (response) => {
          response.resume()
          resolve(response.statusCode)
        })
        upload.on('error', reject)
        upload.write(body.subarray(0, Math.floor(body.length / 2)))
        setTimeout(() => upload.end(body.subarray(Math.floor(body.length / 2))), 1_500)
      })
      const row = await components.database.query<{ created_at: Date }>(
        SQL`SELECT created_at FROM pending_scenes WHERE entity_id = ${entityId}`
      )
      createdAt = row.rows[0].created_at
    })

    it('should admit the upload at the moment the request arrived, not when its body finished', () => {
      expect({ status, admittedBeforeBodyEnded: createdAt.getTime() < sentAt + 1_000 }).toEqual({
        status: 202,
        admittedBeforeBodyEnded: true
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

  describe('when a request carries the most form fields a deployment may send', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      // entityId, partial and a 10-link chain fill the field cap; one payload fills the size cap.
      const authChain = signThroughChainOf(
        MAX_DEPLOYMENT_AUTH_CHAIN_LINKS,
        identity.realAccount,
        entityId,
        MAX_DEPLOYMENT_FIELD_SIZE_IN_BYTES
      )
      response = await post(buildForm([entityId, ...contentHashes], authChain))
    })

    it('should deploy the scene', async () => {
      expect({ status: response.status, deployed: await countDeployedScenes() }).toEqual({ status: 200, deployed: 1 })
    })
  })

  describe('when the auth chain has one link more than the field cap allows', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = signThroughChainOf(MAX_DEPLOYMENT_AUTH_CHAIN_LINKS + 1, identity.realAccount, entityId)
      response = await post(buildForm([entityId, ...contentHashes], authChain))
    })

    it('should reject the request naming the field limit', async () => {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 413,
        body: {
          error: 'Payload Too Large',
          message: 'The multipart request has too many fields. The maximum allowed is 32.'
        }
      })
    })

    it('should not stage the upload', async () => {
      expect(await countPending()).toBe(0)
    })
  })

  describe('when a field is one byte over the per-field size cap', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = signThroughChainOf(3, identity.realAccount, entityId, 32 * 1024 + 1)
      response = await post(buildForm([entityId, ...contentHashes], authChain))
    })

    it('should reject the request naming the field and its size limit', async () => {
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 413,
        body: {
          error: 'Payload Too Large',
          message: "Field 'authChain[1][payload]' is too large. The maximum allowed size per field is 32768 bytes."
        }
      })
    })

    it('should not stage the upload', async () => {
      expect(await countPending()).toBe(0)
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

    describe('and cleanup removes the upload while its completing batch is being validated', () => {
      let completingResponse: Awaited<ReturnType<typeof post>>
      let completingBody: { message?: string }
      let deployedScenes: number

      beforeEach(async () => {
        await post(buildForm([entityId, hashA], authChain))
        // The completing batch already passed its liveness check when expiry cleanup deletes the upload.
        stubComponents.namePermissionChecker.checkPermission.mockImplementation(async () => {
          await components.database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId}`)
          return true
        })
        completingResponse = await post(buildForm([hashB], authChain))
        completingBody = await completingResponse.json()
        deployedScenes = await countDeployedScenes()
      })

      it('should reject the completing request as expired without publishing the scene', () => {
        expect({ status: completingResponse.status, message: completingBody.message, deployedScenes }).toEqual({
          status: 400,
          message: 'This upload expired. Create a new entity with a fresh timestamp.',
          deployedScenes: 0
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

    describe('and the deployer stages the entity file', () => {
      let stagingResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        stagingResponse = await post(buildForm([entityId], authChain))
      })

      it('should accept the staging request with 202', () => {
        expect(stagingResponse.status).toBe(202)
      })

      describe('and another wallet signs the same entity id and continues the upload', () => {
        let resumeResponse: Awaited<ReturnType<typeof post>>
        let resumeBody: { message?: string }
        let pendingAfter: unknown[]
        let storeSpy: jest.SpyInstance

        async function readPendingState(): Promise<unknown[]> {
          const { rows } = await components.database.query(
            SQL`SELECT p.deployer, p.reserved_bytes, p.batches, f.hash, f.charged
                FROM pending_scenes p LEFT JOIN pending_scene_files f ON f.entity_id = p.entity_id
                WHERE p.entity_id = ${entityId} ORDER BY f.hash`
          )
          return rows
        }

        beforeEach(async () => {
          // Another wallet (no deployment permission for this world) signs the same entity id and tries to
          // continue the upload: it must go through the full staging validation and be rejected.
          const otherIdentity = await getIdentity()
          const otherAuthChain = Authenticator.signPayload(otherIdentity.authChain, entityId)
          storeSpy = jest.spyOn(components.storage, 'storeStream')
          resumeResponse = await post(buildForm([contentHashes[0]], otherAuthChain))
          resumeBody = await resumeResponse.json()
          pendingAfter = await readPendingState()
        })

        afterEach(() => {
          storeSpy.mockRestore()
        })

        it('should reject the resume request with 400 asking for the entity file', () => {
          expect({ status: resumeResponse.status, message: resumeBody.message }).toEqual({
            status: 400,
            message: `The first partial request for an entity must include the entity file "${entityId}".`
          })
        })

        it("should leave the deployer's pending upload and its charges unchanged", () => {
          expect(pendingAfter).toEqual([
            {
              deployer: identity.authChain.authChain[0].payload.toLowerCase(),
              reserved_bytes: String(sizeOf(entityId)),
              batches: 1,
              hash: entityId,
              charged: true
            }
          ])
        })

        it('should not store the content the other wallet sent', () => {
          expect(storeSpy.mock.calls.map(([key]) => key)).not.toContain(contentHashes[0])
        })
      })
    })
  })

  describe('when a request is rejected before it needs the content lock', () => {
    let withRead: jest.SpyInstance
    let response: Awaited<ReturnType<typeof post>>
    let body: { message?: string }

    beforeEach(() => {
      withRead = jest.spyOn(components.contentLocks, 'withRead')
    })

    afterEach(() => {
      withRead.mockRestore()
    })

    describe('and a partial batch is signed by an account without deployment permission', () => {
      beforeEach(async () => {
        const other = await getIdentity()
        response = await post(
          buildForm([entityId, contentHashes[0]], Authenticator.signPayload(other.authChain, entityId))
        )
        body = await response.json()
      })

      it('should reject it without taking the content lock', () => {
        expect({ status: response.status, message: body.message, locks: withRead.mock.calls.length }).toEqual({
          status: 400,
          message: expect.stringContaining('Your wallet has no permission to publish this scene'),
          locks: 0
        })
      })
    })

    describe("and a partial batch carries a file that doesn't match its hash", () => {
      beforeEach(async () => {
        files.set(contentHashes[0], stringToUtf8Bytes('tampered'))
        response = await post(
          buildForm([entityId, contentHashes[0]], Authenticator.signPayload(identity.authChain, entityId))
        )
        body = await response.json()
      })

      it('should reject it without taking the content lock', () => {
        expect({ status: response.status, message: body.message, locks: withRead.mock.calls.length }).toEqual({
          status: 400,
          message: expect.stringContaining("The hashed file doesn't match the provided content"),
          locks: 0
        })
      })
    })

    describe('and a regular deployment is signed by an account without deployment permission', () => {
      beforeEach(async () => {
        const other = await getIdentity()
        response = await post(
          buildForm([entityId, ...contentHashes], Authenticator.signPayload(other.authChain, entityId), false)
        )
        body = await response.json()
      })

      it('should reject it without taking the content lock', () => {
        expect({ status: response.status, message: body.message, locks: withRead.mock.calls.length }).toEqual({
          status: 400,
          message: expect.stringContaining('Your wallet has no permission to publish this scene'),
          locks: 0
        })
      })
    })
  })

  describe('when cleanup removes an upload after its next batch skipped the permission check', () => {
    let response: Awaited<ReturnType<typeof post>>
    let body: { message?: string }
    let pending: number
    let permissionChecks: number
    let withReadSpy: jest.SpyInstance

    beforeEach(async () => {
      const { contentLocks, database } = components
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      await post(buildForm([entityId], authChain))
      stubComponents.namePermissionChecker.checkPermission.mockClear()
      const withRead = contentLocks.withRead.bind(contentLocks)
      withReadSpy = jest.spyOn(contentLocks, 'withRead').mockImplementationOnce(async (operation, signal, id) => {
        await database.query(SQL`DELETE FROM pending_scenes WHERE entity_id = ${entityId}`)
        return withRead(operation, signal, id)
      })
      response = await post(buildForm([entityId, contentHashes[0]], authChain))
      body = await response.json()
      pending = await countPending()
      permissionChecks = stubComponents.namePermissionChecker.checkPermission.mock.calls.length
    })

    afterEach(() => {
      withReadSpy.mockRestore()
    })

    it('should reject the batch as expired without starting a new upload', () => {
      expect({ status: response.status, message: body.message, pending, permissionChecks }).toEqual({
        status: 400,
        message: 'This upload expired. Create a new entity with a fresh timestamp.',
        pending: 0,
        permissionChecks: 0
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

  describe('when the completing batch is sent twice concurrently', () => {
    let statuses: number[]
    let timestamps: unknown[]
    let pending: number
    let deployed: number

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      // Stage entity + A, leaving only B missing; both completing requests upload B.
      await post(buildForm([entityId, contentHashes[0]], authChain))
      const responses = await Promise.all([
        post(buildForm([contentHashes[1]], authChain)),
        post(buildForm([contentHashes[1]], authChain))
      ])
      statuses = responses.map((response) => response.status)
      timestamps = await Promise.all(responses.map(async (response) => (await response.json()).creationTimestamp))
      pending = await countPending()
      deployed = await countDeployedScenes()
    })

    it('should answer both with 200', () => {
      expect(statuses).toEqual([200, 200])
    })

    it('should answer both with the same creation timestamp', () => {
      expect(timestamps).toEqual([expect.any(Number), timestamps[0]])
    })

    it('should publish the scene once and leave no staging state', () => {
      expect({ pending, deployed }).toEqual({ pending: 0, deployed: 1 })
    })
  })

  describe('when another authorized signer stages an already deployed entity', () => {
    let publication: { creationTimestamp: number }
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      publication = await (await post(buildForm([entityId, ...contentHashes], authChain))).json()
      const other = await getIdentity()
      const { namePermissionChecker } = stubComponents
      namePermissionChecker.checkPermission.mockResolvedValue(true)
      response = await post(
        buildForm([entityId, contentHashes[0]], Authenticator.signPayload(other.authChain, entityId))
      )
    })

    it('should answer with the publication without leaving a reservation behind', async () => {
      expect({ status: response.status, body: await response.json(), pending: await countPending() }).toEqual({
        status: 200,
        body: expect.objectContaining({ creationTimestamp: publication.creationTimestamp }),
        pending: 0
      })
    })
  })

  describe('when another authorized signer deploys the entity of a live upload without partial', () => {
    let vanillaStatus: number
    let pendingAfterDeploy: number
    let receiptsAfterDeploy: number
    let nextBatch: Awaited<ReturnType<typeof post>>
    let vanillaTimestamp: number

    beforeEach(async () => {
      const { database } = components
      const { namePermissionChecker } = stubComponents
      await post(buildForm([entityId, contentHashes[0]], Authenticator.signPayload(identity.authChain, entityId)))
      const other = await getIdentity()
      namePermissionChecker.checkPermission.mockResolvedValue(true)
      const vanilla = await post(
        buildForm([entityId, ...contentHashes], Authenticator.signPayload(other.authChain, entityId), false)
      )
      vanillaStatus = vanilla.status
      vanillaTimestamp = (await vanilla.json()).creationTimestamp
      pendingAfterDeploy = await countPending()
      const receipts = await database.query<{ count: string }>(
        SQL`SELECT COUNT(*) AS count FROM completed_scene_uploads WHERE entity_id = ${entityId}`
      )
      receiptsAfterDeploy = parseInt(receipts.rows[0].count)
      nextBatch = await post(
        buildForm([entityId, contentHashes[1]], Authenticator.signPayload(identity.authChain, entityId))
      )
    })

    it('should publish it and drop the upload without recording a completion receipt', () => {
      expect({ vanillaStatus, pendingAfterDeploy, receiptsAfterDeploy }).toEqual({
        vanillaStatus: 200,
        pendingAfterDeploy: 0,
        receiptsAfterDeploy: 0
      })
    })

    it("should answer the partial uploader's next batch with the publication", async () => {
      expect({ status: nextBatch.status, body: await nextBatch.json() }).toEqual({
        status: 200,
        body: expect.objectContaining({ creationTimestamp: vanillaTimestamp })
      })
    })
  })

  describe('when a partially deployed entity is undeployed', () => {
    let originalCompletion: { status: number; body: { creationTimestamp: number } }

    function sendAll(signer: Identity, partial = true) {
      return post(
        buildForm([entityId, ...contentHashes], Authenticator.signPayload(signer.authChain, entityId), partial)
      )
    }

    async function toCompletion(response: Awaited<ReturnType<typeof post>>) {
      return { status: response.status, body: await response.json() }
    }

    beforeEach(async () => {
      originalCompletion = await toCompletion(await sendAll(identity))
      await components.worldsManager.undeployWorld(worldName)
    })

    describe('and its finalizer replays the completing request', () => {
      let replay: { status: number; body: { creationTimestamp: number } }
      let deployed: number

      beforeEach(async () => {
        replay = await toCompletion(await sendAll(identity))
        deployed = await countDeployedScenes()
      })

      it('should answer with the original completion without publishing the entity again', () => {
        expect({ status: replay.status, creationTimestamp: replay.body.creationTimestamp, deployed }).toEqual({
          status: 200,
          creationTimestamp: originalCompletion.body.creationTimestamp,
          deployed: 0
        })
      })
    })

    describe('and another authorized signer publishes it again through a partial upload', () => {
      let republication: { status: number; body: { creationTimestamp: number } }
      let republicationRetry: { status: number; body: { creationTimestamp: number } }
      let originalReplay: { status: number; body: { creationTimestamp: number } }

      beforeEach(async () => {
        const other = await getIdentity()
        stubComponents.namePermissionChecker.checkPermission.mockResolvedValue(true)
        republication = await toCompletion(await sendAll(other))
        republicationRetry = await toCompletion(await sendAll(other))
        originalReplay = await toCompletion(await sendAll(identity))
      })

      it("should answer the new finalizer's retry with its own completion", () => {
        expect({
          status: republication.status,
          retryStatus: republicationRetry.status,
          retryCreationTimestamp: republicationRetry.body.creationTimestamp
        }).toEqual({ status: 200, retryStatus: 200, retryCreationTimestamp: republication.body.creationTimestamp })
      })

      it("should answer the earlier finalizer's replay with the live publication", () => {
        expect(originalReplay).toEqual({
          status: 200,
          body: expect.objectContaining({ creationTimestamp: republication.body.creationTimestamp })
        })
      })
    })

    describe('and another authorized signer publishes it again without partial', () => {
      let republication: { status: number; body: { creationTimestamp: number } }
      let receipts: number
      let originalReplay: { status: number; body: { creationTimestamp: number } }

      beforeEach(async () => {
        const other = await getIdentity()
        stubComponents.namePermissionChecker.checkPermission.mockResolvedValue(true)
        republication = await toCompletion(await sendAll(other, false))
        const result = await components.database.query<{ count: string }>(
          SQL`SELECT COUNT(*) AS count FROM completed_scene_uploads WHERE entity_id = ${entityId}`
        )
        receipts = parseInt(result.rows[0].count)
        originalReplay = await toCompletion(await sendAll(identity))
      })

      it('should publish it and drop the earlier completion receipt', () => {
        expect({ republicationStatus: republication.status, receipts }).toEqual({
          republicationStatus: 200,
          receipts: 0
        })
      })

      it("should answer the earlier finalizer's replay with the live publication", () => {
        expect(originalReplay).toEqual({
          status: 200,
          body: expect.objectContaining({ creationTimestamp: republication.body.creationTimestamp })
        })
      })
    })
  })

  describe('when a full deployment of a stale entity has a pending upload', () => {
    let response: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const { database } = components
      const startedAt = Date.now() - 10 * 60 * 1000
      const stale = await DeploymentBuilder.buildEntity({
        type: EntityType.SCENE as any,
        pointers: ['20,24'],
        files: new Map([['file1.txt', stringToUtf8Bytes(makeid(100))]]),
        metadata: {
          main: 'file1.txt',
          scene: { base: '20,24', parcels: ['20,24'] },
          worldConfiguration: { name: worldName }
        },
        timestamp: startedAt
      })
      entityId = stale.entityId
      files = stale.files
      contentHashes = Array.from(files.keys()).filter((k) => k !== entityId)
      const entity = JSON.parse(Buffer.from(files.get(entityId)!).toString())
      const deployer = identity.authChain.authChain[0].payload.toLowerCase()
      await database.query(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at)
        VALUES (${entityId}, ${worldName}, ${['20,24']}::text[], ${entity}::jsonb, ${deployer}, ${new Date(startedAt)})`)
      response = await post(
        buildForm([entityId, ...contentHashes], Authenticator.signPayload(identity.authChain, entityId), false)
      )
    })

    it('should validate its freshness against now instead of the upload start', async () => {
      expect({ status: response.status, body: await response.json(), deployed: await countDeployedScenes() }).toEqual({
        status: 400,
        body: expect.objectContaining({ message: expect.stringContaining('Deployment was created') }),
        deployed: 0
      })
    })
  })

  describe('when another authorized signer sends a batch with the entity file for a live upload', () => {
    let response: Awaited<ReturnType<typeof post>>
    let reservedBefore: string
    let reservedAfter: string

    async function reservedBytes(): Promise<string> {
      const { database } = components
      const result = await database.query<{ reserved_bytes: string }>(
        `SELECT reserved_bytes FROM pending_scenes WHERE entity_id = '${entityId}'`
      )
      return result.rows[0].reserved_bytes
    }

    beforeEach(async () => {
      await post(buildForm([entityId], Authenticator.signPayload(identity.authChain, entityId)))
      reservedBefore = await reservedBytes()
      const other = await getIdentity()
      const { namePermissionChecker } = stubComponents
      namePermissionChecker.checkPermission.mockResolvedValue(true)
      response = await post(
        buildForm([entityId, contentHashes[0]], Authenticator.signPayload(other.authChain, entityId))
      )
      reservedAfter = await reservedBytes()
    })

    it('should reject it without charging the upload owner', async () => {
      expect({
        status: response.status,
        body: await response.json(),
        unchanged: reservedAfter === reservedBefore
      }).toEqual({
        status: 400,
        body: expect.objectContaining({ message: 'This upload was started by another account.' }),
        unchanged: true
      })
    })
  })

  describe('when a batch of a live upload repeats a content file under the same hash', () => {
    let response: Awaited<ReturnType<typeof post>>
    let body: unknown
    let chargesBefore: unknown
    let chargesAfter: unknown

    async function charges(): Promise<unknown> {
      const { database } = components
      const reserved = await database.query<{ reserved_bytes: string }>(
        SQL`SELECT reserved_bytes FROM pending_scenes WHERE entity_id = ${entityId}`
      )
      const rate = await database.query<{ bytes: string }>(SQL`SELECT bytes FROM partial_upload_rates`)
      return { reserved: reserved.rows, rate: rate.rows }
    }

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      await post(buildForm([entityId], authChain))
      chargesBefore = await charges()
      const [repeated] = contentHashes
      response = await post(buildForm([repeated, repeated, repeated], authChain))
      body = await response.json()
      chargesAfter = await charges()
    })

    it('should reject it with 400 without charging the upload or its byte rate', () => {
      expect({ status: response.status, body, chargesAfter }).toEqual({
        status: 400,
        body: expect.objectContaining({ message: `Duplicate form field '${contentHashes[0]}'` }),
        chargesAfter: chargesBefore
      })
    })
  })

  describe('when a request declares partial=true in the query but not in the form', () => {
    let status: number
    let body: unknown
    let deployedScenes: number
    let pending: number

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const response = await post(buildForm([entityId, ...contentHashes], authChain, false), '/entities?partial=true')
      status = response.status
      body = await response.json()
      deployedScenes = await countDeployedScenes()
      pending = await countPending()
    })

    it('should reject it with 400 without deploying or staging anything', () => {
      expect({ status, body, deployedScenes, pending }).toEqual({
        status: 400,
        body: expect.objectContaining({
          message: "The 'partial=true' query parameter requires the 'partial=true' form field"
        }),
        deployedScenes: 0,
        pending: 0
      })
    })
  })

  describe('when a request declares partial=true in both the query and the form', () => {
    let status: number
    let body: unknown

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const response = await post(buildForm([entityId], authChain), '/entities?partial=true')
      status = response.status
      body = await response.json()
    })

    it('should stage it as a partial batch', () => {
      expect({ status, body }).toEqual({
        status: 202,
        body: { missing: expect.arrayContaining(contentHashes) }
      })
    })
  })

  describe('when the first partial request omits the entity file', () => {
    let response: Awaited<ReturnType<typeof post>>
    let body: { message?: string }
    let pending: number

    beforeEach(async () => {
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      response = await post(buildForm([contentHashes[0]], authChain))
      body = await response.json()
      pending = await countPending()
    })

    it('should reject it with 400 asking for the entity file', () => {
      expect({ status: response.status, message: body.message }).toEqual({
        status: 400,
        message: `The first partial request for an entity must include the entity file "${entityId}".`
      })
    })

    it('should not create a pending row', () => {
      expect(pending).toBe(0)
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
        let statuses: number[]
        let pending: number
        let deployed: number

        beforeEach(async () => {
          const responses = await Promise.all([
            post(buildForm([hashA], authChain)),
            post(buildForm([hashB], authChain))
          ])
          // Either may finalize, and both may if they finish storing together.
          statuses = responses.map((response) => response.status).sort()
          pending = await countPending()
          deployed = await countDeployedScenes()
        })

        it('should finalize the upload in at least one of the batches and accept the other', () => {
          expect([
            [200, 200],
            [200, 202]
          ]).toContainEqual(statuses)
        })

        it('should deploy the world exactly once with no leftover pending row', () => {
          expect({ pending, deployed }).toEqual({ pending: 0, deployed: 1 })
        })
      })
    })
  })

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
      stageOlderResponse = await post(
        buildDeploymentForm(older.entityId, olderAuth, older.files, [older.entityId], true)
      )
    })

    it('should accept staging the older scene with 202', () => {
      expect(stageOlderResponse.status).toBe(202)
    })

    describe('and a newer scene is then deployed on the same parcels', () => {
      let newerDeployResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        // The newer scene is deployed on the same parcels via a normal single-request deploy.
        const newerAuth = Authenticator.signPayload(identity.authChain, newer.entityId)
        newerDeployResponse = await post(
          buildDeploymentForm(newer.entityId, newerAuth, newer.files, [newer.entityId, ...newer.contentHashes])
        )
      })

      it('should deploy the newer scene with 200', () => {
        expect(newerDeployResponse.status).toBe(200)
      })

      describe('and the stalled client completes the older upload', () => {
        let completeResponse: Awaited<ReturnType<typeof post>>

        beforeEach(async () => {
          completeResponse = await post(
            buildDeploymentForm(older.entityId, olderAuth, older.files, older.contentHashes, true)
          )
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
        overBudgetResponse = await post(
          buildDeploymentForm(b.entityId, bAuth, b.files, [b.entityId, ...b.contentHashes], true)
        )
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
        await post(buildDeploymentForm(older.entityId, olderAuth, older.files, [older.entityId], true))
        replaceResponse = await post(
          buildDeploymentForm(newer.entityId, newerAuth, newer.files, [newer.entityId], true)
        )
      })

      it('should accept it without replacing the older pending upload', async () => {
        expect(replaceResponse.status).toBe(202)
        expect(await countPending()).toBe(2)
      })

      it('should keep both independent pending uploads', async () => {
        const { database } = components
        const result = await database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
        expect(result.rows.map((r) => r.entity_id).sort()).toEqual([older.entityId, newer.entityId].sort())
      })
    })

    describe('and the incoming upload is older than the pending one', () => {
      let rejectResponse: Awaited<ReturnType<typeof post>>

      beforeEach(async () => {
        await post(buildDeploymentForm(newer.entityId, newerAuth, newer.files, [newer.entityId], true))
        rejectResponse = await post(buildDeploymentForm(older.entityId, olderAuth, older.files, [older.entityId], true))
      })

      it('should accept the older upload without publishing it', () => {
        expect(rejectResponse.status).toBe(202)
      })

      it('should keep both uploads regardless of timestamp order', async () => {
        const { database } = components
        const result = await database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
        expect(result.rows.map((r) => r.entity_id).sort()).toEqual([older.entityId, newer.entityId].sort())
      })
    })
  })

  describe('when a vanilla deploy targets parcels already held by a newer scene', () => {
    let older: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let newer: { entityId: string; files: Map<string, Uint8Array>; contentHashes: string[] }
    let olderResponse: Awaited<ReturnType<typeof post>>
    let olderBody: unknown
    let deployed: string[]
    let olderContentStored: boolean[]
    let deploySceneSpy: jest.SpyInstance

    beforeEach(async () => {
      const now = Date.now()
      older = await buildScene(['20,24'], now - 60_000)
      newer = await buildScene(['20,24'], now)

      // Deploy the newer scene first (full, single-request vanilla deploy).
      const newerAuth = Authenticator.signPayload(identity.authChain, newer.entityId)
      await post(
        buildDeploymentForm(newer.entityId, newerAuth, newer.files, [newer.entityId, ...newer.contentHashes], false)
      )

      // Then a vanilla deploy of the older scene on the same parcels.
      deploySceneSpy = jest.spyOn(components.worldsManager, 'deployScene')
      const olderAuth = Authenticator.signPayload(identity.authChain, older.entityId)
      olderResponse = await post(
        buildDeploymentForm(older.entityId, olderAuth, older.files, [older.entityId, ...older.contentHashes], false)
      )
      olderBody = await olderResponse.json()
      deployed = await deployedEntityIds()
      olderContentStored = [...(await components.storage.existMultiple(older.contentHashes)).values()]
    })

    afterEach(() => {
      deploySceneSpy.mockRestore()
    })

    it('should reject the older vanilla deploy with 400', () => {
      expect({ status: olderResponse.status, body: olderBody }).toEqual({
        status: 400,
        body: expect.objectContaining({
          message: 'Deployment failed: a newer scene is already deployed on one or more of these parcels.'
        })
      })
    })

    it('should reject it in the pre-storage fast-fail without reaching the atomic deploy', () => {
      expect(deploySceneSpy).not.toHaveBeenCalled()
    })

    it('should keep the newer scene deployed', () => {
      expect(deployed).toEqual([newer.entityId])
    })

    it('should not leave the rejected scene content in storage', () => {
      expect(olderContentStored).toEqual(older.contentHashes.map(() => false))
    })
  })

  describe('when a deployer at the cap starts another upload on overlapping parcels', () => {
    // Test config sets MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER=3.
    let replaceResponse: Awaited<ReturnType<typeof post>>

    beforeEach(async () => {
      const now = Date.now()
      // Fill the cap: three distinct uploads on disjoint parcels.
      const parcels = [['20,24'], ['20,25'], ['20,26']]
      const scenes = await Promise.all(parcels.map((p) => buildScene(p, now)))
      for (const scene of scenes) {
        const auth = Authenticator.signPayload(identity.authChain, scene.entityId)
        await post(buildDeploymentForm(scene.entityId, auth, scene.files, [scene.entityId], true))
      }
      // Overlapping uploads are independent and must each consume an admission slot.
      const replacement = await buildScene(['20,24'], now + 1000)
      const replAuth = Authenticator.signPayload(identity.authChain, replacement.entityId)
      replaceResponse = await post(
        buildDeploymentForm(replacement.entityId, replAuth, replacement.files, [replacement.entityId], true)
      )
    })

    it('should reject the additional upload with 429 even though its parcels overlap', () => {
      expect(replaceResponse.status).toBe(429)
    })

    it('should keep the deployer at the cap (net count unchanged)', async () => {
      expect(await countPending()).toBe(3)
    })
  })

  describe('when a deployer exceeds the concurrent-pending upload cap', () => {
    // Test config sets MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER=3.
    let overCapResponse: Awaited<ReturnType<typeof post>>
    let overCapBody: unknown
    let retryAfter: number
    let pending: number

    beforeEach(async () => {
      // Stage three distinct uploads (same deployer + world, disjoint parcels so none replace another).
      const parcels = [['20,24'], ['20,25'], ['20,26'], ['20,27']]
      const scenes = await Promise.all(parcels.map((p, i) => buildScene(p, Date.now() + i)))
      for (let i = 0; i < 3; i++) {
        const auth = Authenticator.signPayload(identity.authChain, scenes[i].entityId)
        await post(buildDeploymentForm(scenes[i].entityId, auth, scenes[i].files, [scenes[i].entityId], true))
      }
      // The fourth new upload exceeds the cap.
      const fourthAuth = Authenticator.signPayload(identity.authChain, scenes[3].entityId)
      overCapResponse = await post(
        buildDeploymentForm(scenes[3].entityId, fourthAuth, scenes[3].files, [scenes[3].entityId], true)
      )
      overCapBody = await overCapResponse.json()
      retryAfter = Number(overCapResponse.headers.get('retry-after'))
      pending = await countPending()
    })

    it('should reject the upload beyond the cap with 429, the quota message and a Retry-After', () => {
      expect({ status: overCapResponse.status, retryAfter, body: overCapBody }).toEqual({
        status: 429,
        retryAfter: expect.any(Number),
        body: {
          error: 'Too Many Requests',
          message:
            'Too many partial uploads in progress for this account: 3 of the 3 allowed. Complete an upload or wait for expired uploads to be cleaned up.'
        }
      })
    })

    it("should retry once the account's oldest upload could expire", () => {
      expect({ withinLifetime: retryAfter <= 3_600, nearExpiry: retryAfter > 3_500 }).toEqual({
        withinLifetime: true,
        nearExpiry: true
      })
    })

    it('should not create a pending row for the rejected upload', () => {
      expect(pending).toBe(3)
    })
  })
})
