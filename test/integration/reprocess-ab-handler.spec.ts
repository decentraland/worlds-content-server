import { test } from '../components'
import { Authenticator } from '@dcl/crypto'

test('reprocess asset-bundles handler /reprocess-ab', function ({ components, stubComponents }) {
  const baseUrl = 'http://0.0.0.0:3000'

  beforeEach(async () => {
    const { config } = stubComponents

    config.getString.withArgs('AWS_SNS_ARN').resolves('some-arn')
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the request body is valid', () => {
    describe('and the world exists', () => {
      let worldName: string
      let entityId: string
      let authChain: any

      beforeEach(async () => {
        const { worldCreator } = components
        const { snsClient } = stubComponents

        const created = await worldCreator.createWorldWithScene({})
        worldName = created.worldName
        entityId = created.entityId
        authChain = Authenticator.signPayload(created.owner, entityId)

        snsClient.publishMessages.resolves({
          successfulMessageIds: [entityId],
          failedEvents: []
        })
      })

      it('should reprocess the specified world', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [{ worldName }] })
        })

        expect(response.status).toEqual(200)
        expect(await response.json()).toEqual({
          baseUrl,
          batch: [
            {
              entity: { entityId, authChain },
              contentServerUrls: [baseUrl]
            }
          ],
          successful: 1,
          failed: 0
        })
      })
    })

    describe('and entityIds are specified', () => {
      let worldName: string
      let entityId: string
      let authChain: any

      beforeEach(async () => {
        const { worldCreator } = components
        const { snsClient } = stubComponents

        const created = await worldCreator.createWorldWithScene({})
        worldName = created.worldName
        entityId = created.entityId
        authChain = Authenticator.signPayload(created.owner, entityId)

        snsClient.publishMessages.resolves({
          successfulMessageIds: [entityId],
          failedEvents: []
        })
      })

      it('should reprocess only the specified entity', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [{ worldName, entityIds: [entityId] }] })
        })

        expect(response.status).toEqual(200)
        expect(await response.json()).toEqual({
          baseUrl,
          batch: [
            {
              entity: { entityId, authChain },
              contentServerUrls: [baseUrl]
            }
          ],
          successful: 1,
          failed: 0
        })
      })

      it('should return bad request when entityId does not exist in the world', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [{ worldName, entityIds: ['nonexistent-entity-id'] }] })
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toEqual({
          error: 'Bad request',
          message: 'No scenes found for reprocessing'
        })
      })
    })

    describe('and the world does not exist', () => {
      it('should return bad request', async () => {
        const { localFetch } = components
        const { snsClient } = stubComponents

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [{ worldName: 'nonexistent.dcl.eth' }] })
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toEqual({
          error: 'Bad request',
          message: 'No scenes found for reprocessing'
        })
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })

  describe('when the request body is invalid', () => {
    describe('and the worlds array is missing', () => {
      it('should return bad request with validation error', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          ok: false,
          message: 'Invalid JSON body'
        })
      })
    })

    describe('and the worlds array is empty', () => {
      it('should return bad request with validation error', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [] })
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          ok: false,
          message: 'Invalid JSON body'
        })
      })
    })

    describe('and the worldName has an invalid format', () => {
      it('should return bad request with validation error', async () => {
        const { localFetch } = components

        const response = await localFetch.fetch('/reprocess-ab', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer setup_some_secret_here',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ worlds: [{ worldName: 'invalid-world-name' }] })
        })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          ok: false,
          message: 'Invalid JSON body'
        })
      })
    })
  })

  describe('when AWS_SNS_ARN is not configured', () => {
    beforeEach(() => {
      const { config } = stubComponents

      config.getString.withArgs('AWS_SNS_ARN').resolves(undefined)
    })

    it('should return internal server error', async () => {
      const { localFetch } = components

      const response = await localFetch.fetch('/reprocess-ab', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer setup_some_secret_here',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ worlds: [{ worldName: 'test.dcl.eth' }] })
      })

      expect(response.status).toEqual(500)
      expect(await response.json()).toMatchObject({ error: 'Internal Server Error' })
    })
  })
})
