import { test } from '../components'
import { WebhookReceiver } from 'livekit-server-sdk'

jest.mock('livekit-server-sdk')

test('LivekitWebhookHandler', function ({ components, stubComponents }) {
  beforeEach(() => {
    const { config } = stubComponents

    config.requireString.withArgs('LIVEKIT_API_KEY').resolves('test_api_key')
    config.requireString.withArgs('LIVEKIT_API_SECRET').resolves('test_api_secret')

    jest.spyOn(WebhookReceiver.prototype, 'receive').mockImplementation((body, auth) => {
      if (auth === 'invalid-auth-token') {
        throw new Error('Invalid auth token')
      }

      return typeof body === 'string' ? JSON.parse(body) : body
    })
  })

  async function makeWebhookRequest(body: any, authorization = 'valid-auth-token') {
    const { localFetch } = components
    return localFetch.fetch('/livekit-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/webhook+json',
        Authorization: authorization
      },
      body: JSON.stringify(body)
    })
  }

  it('should return 400 when authorization header is missing', async () => {
    const r = await makeWebhookRequest({}, '')

    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({
      message: 'Authorization header not found'
    })
  })

  it('should return 400 when participant identity is missing', async () => {
    const event = {
      event: 'participant_joined',
      room: { name: 'test-room.dcl.eth' },
      participant: {}
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({
      message: 'Participant identity not found'
    })
  })

  it('should return 400 when room name is missing', async () => {
    const event = {
      event: 'participant_joined',
      room: {},
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({
      message: 'Room name not found'
    })
  })

  it('should skip event when room name does not end with .dcl.eth', async () => {
    const event = {
      event: 'participant_joined',
      room: { name: 'invalid-room' },
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      message: 'Skipping event'
    })
  })

  it('should skip event when event is not valid', async () => {
    const event = {
      event: 'invalid-event',
      room: { name: 'test-room.dcl.eth' },
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      message: 'Skipping event'
    })
  })

  describe('when event is valid', function () {
    describe('and participant joins', function () {
      const event = {
        event: 'participant_joined',
        room: { name: 'test-room.dcl.eth' },
        participant: { identity: 'test-user' }
      }
      let response: Awaited<ReturnType<typeof makeWebhookRequest>>

      beforeEach(async () => {
        response = await makeWebhookRequest(event)
      })

      it('should publish join event to nats', async () => {
        const { nats } = components
        expect(nats.publish).toHaveBeenCalledWith('peer.test-user.world.join')
      })

      it('should register peer in the registry', async () => {
        const { peersRegistry } = components
        expect(peersRegistry.onPeerConnected).toHaveBeenCalledWith('test-user', 'test-room.dcl.eth')
      })

      it('should return 200', async () => {
        expect(response.status).toBe(200)
      })
    })

    describe('when participant leaves', function () {
      const event = {
        event: 'participant_left',
        room: { name: 'test-room.dcl.eth' },
        participant: { identity: 'test-user' }
      }

      let response: Awaited<ReturnType<typeof makeWebhookRequest>>

      beforeEach(async () => {
        response = await makeWebhookRequest(event)
      })

      it('should publish leave event to nats when participant leaves', async () => {
        const { nats } = components
        expect(nats.publish).toHaveBeenCalledWith('peer.test-user.world.leave')
      })

      it('should unregister peer in the registry', async () => {
        const { peersRegistry } = components
        expect(peersRegistry.onPeerDisconnected).toHaveBeenCalledWith('test-user')
      })

      it('should return 200', async () => {
        expect(response.status).toBe(200)
      })
    })
  })
})
