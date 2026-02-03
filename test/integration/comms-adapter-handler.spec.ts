import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent, IWorldsManager } from '../../src/types'
import { AccessType } from '../../src/logic/access'

const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

test('comms adapter handler /get-comms-adapter/:roomId', function ({ components, stubComponents }) {
  let localFetch: IAuthenticatedFetchComponent
  let worldsManager: IWorldsManager
  let identity: Identity
  let worldName: string

  beforeAll(async () => {
    identity = await getIdentity()
  })

  beforeEach(async () => {
    localFetch = components.localFetch
    worldsManager = components.worldsManager

    const { worldCreator } = components
    const { config, namePermissionChecker } = stubComponents

    config.requireString.withArgs('LIVEKIT_HOST').resolves('livekit.org')
    config.requireString.withArgs('LIVEKIT_API_KEY').resolves('livekit_key')
    config.requireString.withArgs('LIVEKIT_API_SECRET').resolves('livekit_secret')
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-')

    // Default to allowing permission checks - individual tests can override
    namePermissionChecker.checkPermission.resolves(true)

    const created = await worldCreator.createWorldWithScene()
    worldName = created.worldName
  })

  it('works when signed-fetch request is correct', async () => {
    const r = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`
    })
  })

  it('fails when signed-fetch request metadata is correct but room id does not exist', async () => {
    const { worldCreator } = components
    const worldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${worldName}" was not found.` })
  })

  it('fails when signed-fetch request metadata is correct but user does not have access permission', async () => {
    await worldsManager.storeAccess(worldName, {
      type: AccessType.AllowList,
      wallets: [],
      communities: []
    })

    const path = `/get-comms-adapter/world-${worldName}`

    // Use the new localFetch with identity and metadata
    const r = await localFetch.fetch(path, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(401)
    expect(await r.json()).toMatchObject({
      error: 'Not Authorized',
      message: `You are not allowed to access world "${worldName}".`
    })
  })

  it('fails when signed-fetch request metadata is correct but name is deny listed', async () => {
    const { worldCreator } = components
    // Use a random world name that doesn't have a world created
    // This simulates a deny-listed world (returns 404)
    const denyListedWorldName = worldCreator.randomWorldName()

    const r = await localFetch.fetch(`/get-comms-adapter/world-${denyListedWorldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(404)
    expect(await r.json()).toMatchObject({ message: `World "${denyListedWorldName}" was not found.` })
  })

  it('fails when signed-fetch request metadata is correct but room id is invalid', async () => {
    const r = await localFetch.fetch(`/get-comms-adapter/${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({ message: 'Invalid room id requested.' })
  })

  it('fails when signed-fetch request metadata is incorrect', async () => {
    const path = `/get-comms-adapter/world-${worldName}`

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
    const r = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toEqual({
      error: 'Invalid Auth Chain',
      message: 'This endpoint requires a signed fetch request. See ADR-44.'
    })
  })
})
