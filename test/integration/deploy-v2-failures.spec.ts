import { test } from '../components'
import { hashV1 } from '@dcl/hashing'
import { Authenticator } from '@dcl/crypto'
import { EntityType } from '@dcl/schemas'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { stringToUtf8Bytes } from 'eth-connect'
import FormData from 'form-data'
import { getIdentity, makeid, cleanup } from '../utils'

test('partial deployment v2 — failure modes', function ({ components, stubComponents }) {
  afterEach(async () => {
    jest.resetAllMocks()
    const { storage, database } = components
    await cleanup(storage, database)
  })

  /**
   * Initialises a partial deployment and returns the pieces needed for
   * subsequent test steps.  The deployment is left in an "init done,
   * no files uploaded yet" state.
   */
  async function setupInitedDeployment() {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker, nameOwnership, snsClient } = stubComponents

    const identity = await getIdentity()
    const worldName = worldCreator.randomWorldName()

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
    const authChain = Authenticator.signPayload(identity.authChain, entityId)
    const manifest: Record<string, number> = { [contentHash]: contentBuf.length }

    const initForm = new FormData()
    initForm.append('entityId', entityId)
    authChain.forEach((link, index) => {
      initForm.append(`authChain[${index}][payload]`, link.payload)
      initForm.append(`authChain[${index}][signature]`, link.signature)
      initForm.append(`authChain[${index}][type]`, link.type)
    })
    initForm.append(entityId, Buffer.from(entityFileBytes), {
      filename: entityId,
      contentType: 'application/octet-stream'
    })
    initForm.append('fileSizesManifest', JSON.stringify(manifest))

    const initResp = await localFetch.fetch('/entities', {
      method: 'POST',
      headers: { 'Upload-Incomplete': '?1', ...initForm.getHeaders() },
      body: initForm.getBuffer() as any
    })
    expect(initResp.status).toBe(202)

    const initBody = (await initResp.json()) as { missingFiles: string[]; deploymentToken: string }
    return { entityId, contentBuf, contentHash, token: initBody.deploymentToken }
  }

  it('404 (or 400) on file upload to unknown entity', async () => {
    const { localFetch } = components

    const resp = await localFetch.fetch('/entities/QmUnknownEntity000000000000000000000000000000001/files/QmUnknownFile0000000000000000000000000000000001', {
      method: 'POST',
      headers: {
        'X-Deployment-Token': 'some-token',
        'Content-Type': 'application/octet-stream'
      },
      body: Buffer.from('x') as any
    })

    expect([400, 404]).toContain(resp.status)
  })

  it('400 (or 404) on missing X-Deployment-Token header for file upload', async () => {
    const { localFetch } = components

    const { entityId, contentBuf, contentHash } = await setupInitedDeployment()

    const resp = await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
        // X-Deployment-Token intentionally omitted
      },
      body: contentBuf as any
    })

    expect([400, 404]).toContain(resp.status)
  })

  it('400 on token mismatch for file upload', async () => {
    const { localFetch } = components

    const { entityId, contentBuf, contentHash } = await setupInitedDeployment()

    const resp = await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
      method: 'POST',
      headers: {
        'X-Deployment-Token': 'wrong-token-value',
        'Content-Type': 'application/octet-stream'
      },
      body: contentBuf as any
    })

    expect(resp.status).toBe(400)
  })

  it('400 on hash mismatch (declared hash does not match actual content)', async () => {
    const { localFetch } = components

    const { entityId, token, contentHash } = await setupInitedDeployment()

    // Upload bytes whose hash does NOT match contentHash
    const wrongBytes = Buffer.from(makeid(100))

    const resp = await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
      method: 'POST',
      headers: {
        'X-Deployment-Token': token,
        'Content-Type': 'application/octet-stream'
      },
      body: wrongBytes as any
    })

    expect(resp.status).toBe(400)
  })

  it('400 on missing X-Deployment-Token header for finalize', async () => {
    const { localFetch } = components

    const { entityId, contentBuf, contentHash, token } = await setupInitedDeployment()

    // Upload the file correctly first
    await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
      method: 'POST',
      headers: {
        'X-Deployment-Token': token,
        'Content-Type': 'application/octet-stream'
      },
      body: contentBuf as any
    })

    // Finalize without X-Deployment-Token
    const resp = await localFetch.fetch(`/entities/${entityId}`, {
      method: 'POST'
      // X-Deployment-Token intentionally omitted
    })

    expect([400, 404]).toContain(resp.status)
  })

  it('400 on token mismatch for finalize', async () => {
    const { localFetch } = components

    const { entityId, contentBuf, contentHash, token } = await setupInitedDeployment()

    // Upload the file correctly first
    await localFetch.fetch(`/entities/${entityId}/files/${contentHash}`, {
      method: 'POST',
      headers: {
        'X-Deployment-Token': token,
        'Content-Type': 'application/octet-stream'
      },
      body: contentBuf as any
    })

    // Finalize with wrong token
    const resp = await localFetch.fetch(`/entities/${entityId}`, {
      method: 'POST',
      headers: {
        'X-Deployment-Token': 'definitely-the-wrong-token'
      }
    })

    expect(resp.status).toBe(400)
  })

  it('GET /entities/:entityId/status returns 200 with missing files for an active deployment', async () => {
    const { localFetch } = components

    const { entityId, contentHash } = await setupInitedDeployment()

    // No files uploaded yet — contentHash should still be in missingFiles
    const statusResp = await localFetch.fetch(`/entities/${entityId}/status`)
    expect(statusResp.status).toBe(200)

    const statusBody = await statusResp.json()
    expect(statusBody.missingFiles).toContain(contentHash)
    expect(statusBody.expiresAt).toBeGreaterThan(Date.now())
  })

  it('GET /entities/:entityId/status returns 404 for an unknown entity', async () => {
    const { localFetch } = components

    const statusResp = await localFetch.fetch(
      '/entities/QmUnknownEntity000000000000000000000000000000001/status'
    )
    expect(statusResp.status).toBe(404)
  })
})
