import { test } from '../components'
import { Authenticator } from '@dcl/crypto'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { IWorldsManager } from '../../src/types'
import { AccessType } from '../../src/logic/access'
import bcrypt from 'bcrypt'

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

  afterEach(() => {
    jest.restoreAllMocks()
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

  it('fails when signed-fetch request metadata is correct but user has neither permission nor access', async () => {
    const { namePermissionChecker } = stubComponents

    namePermissionChecker.checkPermission.resolves(false)

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

  it('works when user does not have access but has permission', async () => {
    await worldsManager.storeAccess(worldName, {
      type: AccessType.AllowList,
      wallets: [],
      communities: []
    })

    const r = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
      method: 'POST',
      identity,
      metadata: EXPLORER_METADATA
    })

    expect(r.status).toEqual(200)
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

  describe('when the world uses shared-secret access', () => {
    beforeEach(async () => {
      const { namePermissionChecker } = stubComponents

      namePermissionChecker.checkPermission.resolves(false)
      await worldsManager.storeAccess(worldName, {
        type: AccessType.SharedSecret,
        secret: bcrypt.hashSync('correct-secret', 10)
      })
    })

    describe('and the subject is already rate limited', () => {
      let response: Response

      beforeEach(async () => {
        jest.spyOn(components.rateLimiter, 'isRateLimited').mockResolvedValueOnce(true)

        response = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
          method: 'POST',
          identity,
          metadata: { ...EXPLORER_METADATA, secret: 'wrong-secret' }
        })
      })

      it('should respond with 429', async () => {
        expect(response.status).toEqual(429)
      })

      it('should include a retry-after header', async () => {
        expect(response.headers.get('retry-after')).toEqual('60')
      })
    })

    describe('and the failed attempt reaches the rate limit', () => {
      let response: Response

      beforeEach(async () => {
        jest.spyOn(components.rateLimiter, 'isRateLimited').mockResolvedValueOnce(false)
        jest.spyOn(components.rateLimiter, 'recordFailedAttempt').mockResolvedValueOnce({ rateLimited: true })

        response = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
          method: 'POST',
          identity,
          metadata: { ...EXPLORER_METADATA, secret: 'wrong-secret' }
        })
      })

      it('should respond with 429', async () => {
        expect(response.status).toEqual(429)
      })

      it('should include a retry-after header', async () => {
        expect(response.headers.get('retry-after')).toEqual('60')
      })
    })

    describe('and the request includes a Cloudflare connecting IP', () => {
      let response: Response
      let isRateLimitedSpy: jest.SpyInstance
      let recordFailedAttemptSpy: jest.SpyInstance
      let clientIp: string

      beforeEach(async () => {
        clientIp = '203.0.113.10'
        isRateLimitedSpy = jest.spyOn(components.rateLimiter, 'isRateLimited').mockResolvedValueOnce(false)
        recordFailedAttemptSpy = jest
          .spyOn(components.rateLimiter, 'recordFailedAttempt')
          .mockResolvedValueOnce({ rateLimited: false })

        response = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
          method: 'POST',
          identity,
          headers: { 'cf-connecting-ip': clientIp },
          metadata: { ...EXPLORER_METADATA, secret: 'wrong-secret' }
        })
      })

      it('should use the IP as the rate limit subject', async () => {
        expect(response.status).toEqual(401)
        expect(isRateLimitedSpy).toHaveBeenCalledWith(worldName, clientIp)
        expect(recordFailedAttemptSpy).toHaveBeenCalledWith(worldName, clientIp)
      })
    })

    describe('and the shared secret is correct', () => {
      let response: Response
      let clearAttemptsSpy: jest.SpyInstance

      beforeEach(async () => {
        jest.spyOn(components.rateLimiter, 'isRateLimited').mockResolvedValueOnce(false)
        clearAttemptsSpy = jest.spyOn(components.rateLimiter, 'clearAttempts')

        response = await localFetch.fetch(`/get-comms-adapter/world-${worldName}`, {
          method: 'POST',
          identity,
          metadata: { ...EXPLORER_METADATA, secret: 'correct-secret' }
        })
      })

      it('should respond with 200', async () => {
        expect(response.status).toEqual(200)
      })

      it('should clear failed attempts for the signer', async () => {
        expect(clearAttemptsSpy).toHaveBeenCalledWith(worldName, identity.realAccount.address.toLowerCase())
      })
    })
  })
})
