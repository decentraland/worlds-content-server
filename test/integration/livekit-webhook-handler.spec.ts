import { test } from '../components'
import { WebhookReceiver } from 'livekit-server-sdk'

jest.mock('livekit-server-sdk')

test('livekit webhook handler /livekit-webhook', function ({ components, stubComponents }) {
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

  it('returns 400 when authorization header is missing', async () => {
    const r = await makeWebhookRequest({}, '')

    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({
      message: 'Authorization header not found'
    })
  })

  it('returns 400 when participant identity is missing', async () => {
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

  it('returns 400 when room name is missing', async () => {
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

  it('skips event when room name does not end with .dcl.eth', async () => {
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

  it('skips event when event is not valid', async () => {
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

  it('publishes join event to nats when participant joins', async () => {
    const { nats } = components
    const event = {
      event: 'participant_joined',
      room: { name: 'test-room.dcl.eth' },
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(200)
    expect(nats.publish).toHaveBeenCalledWith('peer.test-user.world.join')
  })

  it('publishes leave event to nats when participant leaves', async () => {
    const { nats } = components
    const event = {
      event: 'participant_left',
      room: { name: 'test-room.dcl.eth' },
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event)

    expect(r.status).toBe(200)
    expect(nats.publish).toHaveBeenCalledWith('peer.test-user.world.leave')
  })

  it('returns 500 when webhook validation fails', async () => {
    const event = {
      event: 'participant_joined',
      room: { name: 'test-room.dcl.eth' },
      participant: { identity: 'test-user' }
    }

    const r = await makeWebhookRequest(event, 'invalid-auth-token')

    expect(r.status).toBe(500)
    expect(await r.json()).toMatchObject({
      message: 'Error receiving livekit webhook',
      error: 'Invalid auth token'
    })
  })
})
