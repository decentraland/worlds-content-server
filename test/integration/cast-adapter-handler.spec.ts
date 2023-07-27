import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { getAuthHeaders, getIdentity, storeJson, Identity } from '../utils'

test('cast adapter handler /cast-adapter/:roomId', function ({ components, stubComponents }) {
  function makeRequest(path: string, identity: Identity) {
    const { localFetch } = components
    return localFetch.fetch(path, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(
          'post',
          path,
          {
            origin: 'https://play.decentraland.org',
            intent: 'dcl:explorer:comms-handshake',
            signer: 'dcl:explorer',
            isGuest: 'false'
          },
          (payload) =>
            Authenticator.signPayload(
              {
                ephemeralIdentity: identity.ephemeralIdentity,
                expiration: new Date(),
                authChain: identity.authChain.authChain
              },
              payload
            )
        )
      }
    })
  }

  let identity: Identity
  beforeAll(async () => {
    identity = await getIdentity()
  })

  beforeEach(() => {
    const { config } = stubComponents
    config.requireString.withArgs('LIVEKIT_HOST').resolves('livekit.org')
    config.requireString.withArgs('LIVEKIT_API_KEY').resolves('livekit_key')
    config.requireString.withArgs('LIVEKIT_API_SECRET').resolves('livekit_secret')
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-')
  })

  it('works when signed-fetch request is correct', async () => {
    const { storage } = components
    await storeJson(storage, 'name-myRoom', '')
    const r = await makeRequest('/cast-adapter/world-myRoom', identity)
    expect(r.status).toEqual(200)
    const { token, url } = await r.json()
    expect(url).toEqual('wss://livekit.org')
    expect(token).toBeTruthy()
  })

  it('fails when signed-fetch request metadata is correct but room id does not exist', async () => {
    const r = await makeRequest('/cast-adapter/world-noRoom', identity)
    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: 'World "noRoom" does not exist.' })
  })

  it('fails when signed-fetch request metadata is correct but room id is invalid', async () => {
    const path = '/cast-adapter/myRoom'
    const r = await makeRequest(path, identity)

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid room id requested.' })
  })

  it('fails when signed-fetch request metadata is incorrect', async () => {
    const { localFetch } = components
    const path = '/cast-adapter/myRoom'

    const r = await localFetch.fetch(path, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(
          'post',
          path,
          {
            origin: 'https://play.decentraland.org'
          },
          (payload) =>
            Authenticator.signPayload(
              {
                ephemeralIdentity: identity.ephemeralIdentity,
                expiration: new Date(),
                authChain: identity.authChain.authChain
              },
              payload
            )
        )
      }
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: 'Access denied, invalid metadata'
    })
  })

  it('fails when request is not a signed-fetch one', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/cast-adapter/roomId', {
      method: 'POST'
    })

    expect(r.status).toEqual(401)
    expect(await r.json()).toEqual({
      message: 'Access denied, invalid signed-fetch request',
      ok: false
    })
  })
})
