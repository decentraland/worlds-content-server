import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { DeploymentToSqs } from '@dcl/schemas/dist/misc/deployments-to-sqs'

test('reprocess asset-bundles handler /reprocess-ab', function ({ components, stubComponents }) {
  beforeEach(async () => {
    const { config } = stubComponents
    config.getString.withArgs('SNS_ARN').resolves('some-arn')
  })

  it('can reprocess specified worlds', async () => {
    const { localFetch, worldCreator } = components
    const { snsClient } = stubComponents

    const { entityId, owner, worldName } = await worldCreator.createWorldWithScene({})
    const authChain = Authenticator.signPayload(owner, entityId)

    snsClient.publishBatch.resolves({
      Successful: [{ Id: entityId, MessageId: 'mocked-message-id', SequenceNumber: '1' }],
      Failed: [],
      $metadata: {}
    })

    const r = await localFetch.fetch(`/reprocess-ab`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer setup_some_secret_here'
      },
      body: JSON.stringify([worldName])
    })

    const baseUrl = `http://0.0.0.0:3000`
    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      baseUrl: baseUrl,
      batch: [
        {
          entity: {
            entityId,
            authChain
          },
          contentServerUrls: [baseUrl]
        }
      ],
      successful: 1,
      failed: 0
    })
  })

  it('returns bad request when no worlds to reprocess', async () => {
    const { localFetch } = components
    const { snsClient } = stubComponents

    const r = await localFetch.fetch(`/reprocess-ab`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer setup_some_secret_here'
      },
      body: JSON.stringify(['nonexistent.dcl.eth'])
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toEqual({
      error: 'Bad request',
      message: 'No worlds found for reprocessing'
    })
    expect(snsClient.publishBatch).not.toHaveBeenCalled()
  })

  it('can reprocess all worlds', async () => {
    const { localFetch, worldCreator } = components
    const { snsClient } = stubComponents

    const { entityId, owner } = await worldCreator.createWorldWithScene({})
    const authChain = Authenticator.signPayload(owner, entityId)

    snsClient.publishBatch.resolves({
      Successful: [{ Id: 'mocked-id', MessageId: 'mocked-message-id', SequenceNumber: '1' }],
      Failed: [],
      $metadata: {}
    })

    const r = await localFetch.fetch(`/reprocess-ab`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer setup_some_secret_here'
      }
    })

    const baseUrl = `http://0.0.0.0:3000`
    expect(r.status).toEqual(200)
    expect(await r.json()).toMatchObject({
      baseUrl: baseUrl,
      batch: expect.arrayContaining<DeploymentToSqs>([
        {
          entity: {
            entityId,
            authChain
          },
          contentServerUrls: [baseUrl]
        }
      ]),
      successful: expect.any(Number),
      failed: 0
    })
  })

  it('can not be called if no SNS_ARN configured', async () => {
    const { localFetch } = components
    const { config } = stubComponents

    config.getString.withArgs('SNS_ARN').resolves(undefined)

    const r = await localFetch.fetch(`/reprocess-ab`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer setup_some_secret_here'
      }
    })
    expect(r.status).toEqual(500)
    expect(await r.json()).toMatchObject({ error: 'Internal Server Error' })
  })
})
