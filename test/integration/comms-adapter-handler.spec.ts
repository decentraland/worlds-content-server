import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { getAuthHeaders, getIdentity, Identity } from '../utils'

test('comms adapter handler /get-comms-adapter/:roomId', function ({ components, stubComponents }) {
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
    const { worldCreator } = components
    const { worldName } = await worldCreator.createWorldWithScene()

    const r = await makeRequest(`/get-comms-adapter/world-${worldName}`, identity)

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`
    })
  })

  it('fails when signed-fetch request metadata is correct but room id does not exist', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await makeRequest(`/get-comms-adapter/world-${worldName}`, identity)

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" does not exist.` })
  })

  it('fails when signed-fetch request metadata is correct but name is deny listed', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const { nameDenyListChecker } = stubComponents
    nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(false)

    const r = await makeRequest(`/get-comms-adapter/world-${worldName}`, identity)

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" does not exist.` })
  })

  it('fails when signed-fetch request metadata is correct but room id is invalid', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await makeRequest(`/get-comms-adapter/${worldName}`, identity)

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid room id requested.' })
  })

  it('fails when signed-fetch request metadata is incorrect', async () => {
    const { localFetch, worldCreator } = components
    const worldName = worldCreator.randomWorldName()
    const path = `/get-comms-adapter/world-${worldName}`

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
    const { localFetch, worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
      method: 'POST'
    })

    expect(r.status).toEqual(401)
    expect(await r.json()).toEqual({
      message: 'Access denied, invalid signed-fetch request',
      ok: false
    })
  })
})
