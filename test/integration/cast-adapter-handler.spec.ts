import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent } from '../../src/types'

const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

test('cast adapter handler /cast-adapter/:roomId', function ({ components, stubComponents }) {
  let localFetch: IAuthenticatedFetchComponent
  let identity: Identity

  beforeAll(async () => {
    identity = await getIdentity()
  })

  beforeEach(() => {
    localFetch = components.localFetch

    const { config } = stubComponents
    config.requireString.withArgs('LIVEKIT_HOST').resolves('livekit.org')
    config.requireString.withArgs('LIVEKIT_API_KEY').resolves('livekit_key')
    config.requireString.withArgs('LIVEKIT_API_SECRET').resolves('livekit_secret')
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-')
  })

  it('works when signed-fetch request is correct', async () => {
    const { worldCreator } = components
    const { worldName } = await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch(`/cast-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(200)
    const { token, url } = await r.json()
    expect(url).toEqual('wss://livekit.org')
    expect(token).toBeTruthy()
  })

  it('fails when signed-fetch request metadata is correct but room id does not exist', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/cast-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" was not found.` })
  })

  it('fails when signed-fetch request metadata is correct but name is deny listed', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const { nameDenyListChecker } = stubComponents
    nameDenyListChecker.checkNameDenyList.withArgs(worldName).resolves(false)

    const r = await localFetch.fetch(`/cast-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" was not found.` })
  })

  it('fails when signed-fetch request metadata is correct but room id is invalid', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/cast-adapter/${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid room id requested.' })
  })

  it('fails when signed-fetch request metadata is incorrect', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()
    const path = `/cast-adapter/world-${worldName}`

    // Use raw fetch with incomplete metadata
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
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/cast-adapter/world-${worldName}`, {
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toEqual({
      error: 'Invalid Auth Chain',
      message: 'This endpoint requires a signed fetch request. See ADR-44.'
    })
  })
})
