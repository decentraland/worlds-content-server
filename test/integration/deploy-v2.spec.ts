import { test } from '../components'
import { hashV1 } from '@dcl/hashing'
import { Authenticator } from '@dcl/crypto'
import { EntityType } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { stringToUtf8Bytes } from 'eth-connect'
import FormData from 'form-data'
import { getIdentity, makeid, cleanup } from '../utils'

test('partial deployment v2 — happy path', function ({ components, stubComponents }) {
  afterEach(async () => {
    jest.resetAllMocks()
    const { storage, database } = components
    await cleanup(storage, database)
  })

  describe('when the user owns the world name', () => {
    let worldName: string

    beforeEach(async () => {
      const { worldCreator } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      worldName = worldCreator.randomWorldName()

      const identity = await getIdentity()
      namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload, worldName)
        .resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })
    })

    it('completes init -> file upload -> finalize', async () => {
      const { localFetch } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      const identity = await getIdentity()

      // Override stubs to match the specific identity we use in this test
      namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload, worldName)
        .resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })

      // Build an entity with a content file
      const contentBytes = stringToUtf8Bytes(makeid(100))
      const contentBuf = Buffer.from(contentBytes)
      const contentHash = await hashV1(contentBytes)

      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', contentBytes)

      const { entityId, files } = await DeploymentBuilder.buildEntity({
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

      const entityFileBytes = files.get(entityId)!

      // Build auth chain signed over the entityId
      const authChain = Authenticator.signPayload(identity.authChain, entityId)

      // Build manifest: map of fileHash -> byte length for non-entity content files
      const manifest: Record<string, number> = {}
      manifest[contentHash] = contentBuf.length

      // Step 1: Init — POST /entities with Upload-Incomplete: ?1
      const initForm = new FormData()
      initForm.append('entityId', entityId)

      // Append auth chain fields as authChain[i][payload], authChain[i][signature], authChain[i][type]
      authChain.forEach((link, index) => {
        initForm.append(`authChain[${index}][payload]`, link.payload)
        initForm.append(`authChain[${index}][signature]`, link.signature)
        initForm.append(`authChain[${index}][type]`, link.type)
      })

      // Append the entity file under its own hash as the filename
      initForm.append(entityId, Buffer.from(entityFileBytes), { filename: entityId, contentType: 'application/octet-stream' })

      // Append the fileSizesManifest (covers only non-entity content files)
      initForm.append('fileSizesManifest', JSON.stringify(manifest))

      const initResp = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: { 'Upload-Incomplete': '?1', ...initForm.getHeaders() },
        body: initForm.getBuffer() as any
      })
      expect(initResp.status).toBe(202)

      const initBody = (await initResp.json()) as { missingFiles: string[]; deploymentToken: string }
      expect(initBody.deploymentToken).toBeTruthy()
      expect(initBody.missingFiles).toContain(contentHash)

      // Step 2: Upload the missing content file — POST /entities/:entityId/files/:fileHash
      const uploadResp = await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
        method: 'POST',
        headers: {
          'X-Deployment-Token': initBody.deploymentToken,
          'Content-Type': 'application/octet-stream'
        },
        body: contentBuf as any
      })
      expect(uploadResp.status).toBe(204)

      // Step 3: Finalize — POST /entities/:entityId
      const finalResp = await localFetch.fetch(`/entities/${entityId}`, {
        method: 'POST',
        headers: {
          'X-Deployment-Token': initBody.deploymentToken
        }
      })
      expect(finalResp.status).toBe(200)
      const finalBody = await finalResp.json()
      expect(finalBody).toMatchObject({ creationTimestamp: expect.any(Number) })
    })

    it('returns available files on re-init for the same entity and owner', async () => {
      const { localFetch } = components
      const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

      const identity = await getIdentity()

      namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload, worldName)
        .resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))
      snsClient.publishMessage.resolves({
        MessageId: 'mocked-message-id',
        SequenceNumber: 'mocked-sequence-number',
        $metadata: {}
      })

      const contentBytes = stringToUtf8Bytes(makeid(100))
      const contentHash = await hashV1(contentBytes)

      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', contentBytes)

      const { entityId, files } = await DeploymentBuilder.buildEntity({
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

      const entityFileBytes = files.get(entityId)!
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const manifest: Record<string, number> = { [contentHash]: contentBytes.length }

      const buildInitForm = () => {
        const form = new FormData()
        form.append('entityId', entityId)
        authChain.forEach((link, index) => {
          form.append(`authChain[${index}][payload]`, link.payload)
          form.append(`authChain[${index}][signature]`, link.signature)
          form.append(`authChain[${index}][type]`, link.type)
        })
        form.append(entityId, Buffer.from(entityFileBytes), { filename: entityId, contentType: 'application/octet-stream' })
        form.append('fileSizesManifest', JSON.stringify(manifest))
        return form
      }

      // First init
      const firstForm = buildInitForm()
      const firstResp = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: { 'Upload-Incomplete': '?1', ...firstForm.getHeaders() },
        body: firstForm.getBuffer() as any
      })
      expect(firstResp.status).toBe(202)
      const firstBody = (await firstResp.json()) as { deploymentToken: string }

      // Second init (same entity, same owner) — should return the same token
      const secondForm = buildInitForm()
      const secondResp = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: { 'Upload-Incomplete': '?1', ...secondForm.getHeaders() },
        body: secondForm.getBuffer() as any
      })
      expect(secondResp.status).toBe(202)
      const secondBody = (await secondResp.json()) as { deploymentToken: string }

      expect(secondBody.deploymentToken).toBe(firstBody.deploymentToken)
    })

    it('GET /entities/:entityId/status returns the deployment status with missing files', async () => {
      const { localFetch } = components
      const { namePermissionChecker, nameOwnership } = stubComponents

      const identity = await getIdentity()

      namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload, worldName)
        .resolves(true)
      nameOwnership.findOwners
        .withArgs([worldName])
        .resolves(new Map([[worldName, identity.authChain.authChain[0].payload]]))

      const contentBytes = stringToUtf8Bytes(makeid(100))
      const contentHash = await hashV1(contentBytes)

      const entityFiles = new Map<string, Uint8Array>()
      entityFiles.set('abc.txt', contentBytes)

      const { entityId, files } = await DeploymentBuilder.buildEntity({
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

      const entityFileBytes = files.get(entityId)!
      const authChain = Authenticator.signPayload(identity.authChain, entityId)
      const manifest: Record<string, number> = { [contentHash]: contentBytes.length }

      const initForm = new FormData()
      initForm.append('entityId', entityId)
      authChain.forEach((link, index) => {
        initForm.append(`authChain[${index}][payload]`, link.payload)
        initForm.append(`authChain[${index}][signature]`, link.signature)
        initForm.append(`authChain[${index}][type]`, link.type)
      })
      initForm.append(entityId, Buffer.from(entityFileBytes), { filename: entityId, contentType: 'application/octet-stream' })
      initForm.append('fileSizesManifest', JSON.stringify(manifest))

      const initResp = await localFetch.fetch('/entities', {
        method: 'POST',
        headers: { 'Upload-Incomplete': '?1', ...initForm.getHeaders() },
        body: initForm.getBuffer() as any
      })
      expect(initResp.status).toBe(202)

      // Status should show missing files before upload
      const statusResp = await localFetch.fetch(`/entities/${entityId}/status`)
      expect(statusResp.status).toBe(200)
      const statusBody = await statusResp.json()
      expect(statusBody.missingFiles).toContain(contentHash)
      expect(statusBody.expiresAt).toBeGreaterThan(Date.now())
    })
  })
})
