import { test } from '../components'
import { getAuthHeaders, getAuthHeadersAt, getIdentity, getLegacyAuthHeaders, Identity, signWith } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { IWorldsManager } from '../../src/types'
import { AccessType } from '../../src/logic/access'
import { AuthLinkType, Authenticator } from '@dcl/crypto'
import { AuthChain } from '@dcl/schemas'

const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

test('world comms handler', function ({ components, stubComponents }) {
  describe('when requesting a world room connection', () => {
    let localFetch: IAuthenticatedFetchComponent
    let worldsManager: IWorldsManager
    let identity: Identity
    let worldName: string

    beforeEach(async () => {
      localFetch = components.localFetch
      worldsManager = components.worldsManager
      identity = await getIdentity()

      const { worldCreator } = components
      const { namePermissionChecker } = stubComponents

      namePermissionChecker.checkPermission.mockResolvedValue(true)

      const created = await worldCreator.createWorldWithScene()
      worldName = created.worldName
    })

    describe('and the request is valid', () => {
      it('should respond with 200 and the connection string', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`
        })
      })
    })

    describe('and the world does not exist', () => {
      let nonExistentWorld: string

      beforeEach(() => {
        const { worldCreator } = components
        nonExistentWorld = worldCreator.randomWorldName()
      })

      it('should respond with 404 and the invalid world error', async () => {
        const r = await localFetch.fetch(`/worlds/${nonExistentWorld}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('invalid or blocked')
      })
    })

    describe('and the user has neither permission nor access', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.mockResolvedValue(false)

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 401 and the not-allowed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('not allowed to access')
      })
    })

    describe('and the user does not have access but has permission', () => {
      beforeEach(async () => {
        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the user is on the allow list', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.mockResolvedValue(false)

        const userAddress = identity.authChain.authChain[0].payload.toLowerCase()
        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [userAddress],
          communities: []
        })
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the user is denylisted', () => {
      beforeEach(() => {
        const { denyList } = stubComponents as any
        denyList.isDenylisted.mockResolvedValue(true)
      })

      it('should respond with 401 and the deny-listed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('deny-listed')
      })
    })

    describe('and the user is platform-banned', () => {
      beforeEach(() => {
        const { bans } = stubComponents as any
        bans.isPlayerBanned.mockResolvedValue(true)
      })

      it('should respond with 401 and the platform-banned error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('platform-banned')
      })
    })

    describe('and the world has been undeployed but the world record still exists', () => {
      beforeEach(async () => {
        await worldsManager.undeployWorld(worldName)
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the request is not signed', () => {
      it('should respond with 400 and the signed-fetch error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST'
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toEqual({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })

    describe('and the signed-fetch metadata has a kernel-scene signer', () => {
      it('should respond with 400', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: {
            ...EXPLORER_METADATA,
            signer: 'decentraland-kernel-scene'
          }
        })

        expect(r.status).toEqual(400)
      })
    })

    describe.each([['Decentraland-Kernel-Scene'], ['DECENTRALAND-KERNEL-SCENE'], [' decentraland-kernel-scene ']])(
      'and the signed-fetch metadata spells the kernel-scene signer as "%s"',
      (signer) => {
        // @dcl/crypto-middleware 6 signs the metadata bytes verbatim, so what the header carries is
        // exactly what was signed and the request reaches the router with a valid signature. The
        // library no longer rejects a non-canonical `signer` on its own; the scene gate in routes.ts
        // normalizes the value before comparing, and that is what refuses the request here.
        it('should respond with 400 rather than let it past the scene gate', async () => {
          const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
            method: 'POST',
            identity,
            metadata: {
              ...EXPLORER_METADATA,
              signer
            }
          })

          expect(r.status).toEqual(400)
          expect(await r.json()).toMatchObject({ error: expect.stringMatching(/^Invalid metadata content: /) })
        })
      }
    )

    describe.each([
      ['a mixed-case spelling', 'Dcl:Explorer'],
      ['a padded spelling', ' dcl:explorer ']
    ])('and signed-fetch metadata has a non-canonical signer in %s', (_case, value) => {
      // `rejectIfSigner` refuses a `signer` that is not already canonical, not merely one matching
      // the sentinel. That is deliberate: the gate compares by equality, and a value it cannot
      // compare meaningfully is refused rather than waved through. So a non-canonical `dcl:explorer`
      // is rejected too, even though it is not the scene signer.
      it('should respond with 400', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: { ...EXPLORER_METADATA, signer: value }
        })

        expect(r.status).toEqual(400)
      })
    })

    describe.each([
      ['a mixed-case spelling', 'Dcl:Explorer:Comms-Handshake'],
      ['a padded spelling', ' dcl:explorer:comms-handshake ']
    ])('and signed-fetch metadata has a non-canonical intent in %s', (_case, value) => {
      // `intent` is not gated on this route, so nothing refuses it. Up to 5.1.0 the library did,
      // via a canonical guard it applied to every request; 6.x leaves that to the service, and this
      // route has no reason to care. The value is still bound to the signature, so it cannot be
      // re-spelled in flight — this is a request genuinely signed that way.
      //
      // Note the /comms adapter route DOES compare `intent`; if that check ever moves here it
      // should use requireCanonicalField('intent', ...) rather than a bare equality.
      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          identity,
          metadata: { ...EXPLORER_METADATA, intent: value }
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the auth chain has a malformed link', () => {
      it('should respond with 400', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/comms`, {
          method: 'POST',
          headers: {
            'x-identity-auth-chain-0': JSON.stringify({ type: 'SIGNER' }),
            'x-identity-auth-chain-1': JSON.stringify({ type: 'ECDSA_PERSONAL_EPHEMERAL' })
          }
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: expect.stringMatching(/^Invalid chain format: malformed auth link/)
        })
      })
    })

    describe('and the signed-fetch timestamp is expired', () => {
      it('should respond with 401', async () => {
        const path = `/worlds/${worldName}/comms`
        const r = await localFetch.fetch(path, {
          method: 'POST',
          headers: getAuthHeadersAt(Date.now() - 10 * 60 * 1000, 'POST', path, EXPLORER_METADATA, (payload) =>
            Authenticator.signPayload(
              {
                ephemeralIdentity: identity.ephemeralIdentity,
                expiration: new Date(),
                authChain: identity.authChain.authChain
              },
              payload
            )
          )
        })

        expect(r.status).toEqual(401)
        expect(await r.json()).toMatchObject({ error: expect.stringMatching(/^Expired signature:/) })
      })
    })

    describe('and the signature was made for a different payload', () => {
      it('should respond with 401', async () => {
        const path = `/worlds/${worldName}/comms`
        const r = await localFetch.fetch(path, {
          method: 'POST',
          headers: getAuthHeaders('POST', `${path}/other`, EXPLORER_METADATA, (payload) =>
            Authenticator.signPayload(
              {
                ephemeralIdentity: identity.ephemeralIdentity,
                expiration: new Date(),
                authChain: identity.authChain.authChain
              },
              payload
            )
          )
        })

        expect(r.status).toEqual(401)
        expect(await r.json()).toMatchObject({ error: expect.stringMatching(/^Invalid signature:/) })
      })
    })

    describe('and the auth chain signs the legacy method:path payload', () => {
      it('should respond with 401 despite ADR-44 headers being present', async () => {
        const path = `/worlds/${worldName}/comms`
        const timestamp = Date.now()
        const metadataJSON = JSON.stringify(EXPLORER_METADATA)
        const legacyPayload = `POST:${path}`.toLowerCase()
        const chain = Authenticator.signPayload(
          {
            ephemeralIdentity: identity.ephemeralIdentity,
            expiration: new Date(),
            authChain: identity.authChain.authChain
          },
          legacyPayload
        )
        const headers: Record<string, string> = {
          'x-identity-timestamp': String(timestamp),
          'x-identity-metadata': metadataJSON
        }
        chain.forEach((link, index) => {
          headers[`x-identity-auth-chain-${index}`] = JSON.stringify(link)
        })

        const r = await localFetch.fetch(path, { method: 'POST', headers })

        expect(r.status).toEqual(401)
        expect(await r.json()).toMatchObject({ error: expect.stringMatching(/^Invalid signature:/) })
      })
    })

    describe('and the auth chain signs the pre-6.0.0 folded payload', () => {
      let path: string
      let headers: Record<string, string>

      beforeEach(() => {
        path = `/worlds/${worldName}/comms`
        headers = getLegacyAuthHeaders('POST', path, EXPLORER_METADATA, signWith(identity))
      })

      // `isGuest` alone makes folding the metadata a lossy operation, so the current-format check
      // cannot verify this and falls through. The comms routes opt into the fallback because the
      // three explorer clients still sign this way and cannot be released with the service.
      it('should respond with 200 and the connection string', async () => {
        const r = await localFetch.fetch(path, { method: 'POST', headers })

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/world-${worldName}`
        })
      })
    })

    describe('and the pre-6.0.0 payload delivers the scene signer under a re-cased key', () => {
      let path: string
      let headers: Record<string, string>

      beforeEach(() => {
        path = `/worlds/${worldName}/comms`
        // No lowercase `signer` at all, so `rejectIfSigner` reads the field as absent and the scene
        // gate passes it. Folded, this metadata signs identically to the same object spelling the
        // key `signer` — which is exactly the bypass the declared-key guard exists to close.
        const { signer: _omitted, ...withoutSigner } = EXPLORER_METADATA
        headers = getLegacyAuthHeaders(
          'POST',
          path,
          { ...withoutSigner, Signer: 'decentraland-kernel-scene' },
          signWith(identity)
        )
      })

      it('should respond with 400 and the declared-spelling error rather than run the handshake', async () => {
        const r = await localFetch.fetch(path, { method: 'POST', headers })

        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: expect.stringContaining('Invalid chain metadata: expected "signer", got "Signer"')
        })
      })
    })

    describe('and the pre-6.0.0 payload delivers a re-cased secret', () => {
      let path: string
      let headers: Record<string, string>

      beforeEach(() => {
        path = `/worlds/${worldName}/comms`
        headers = getLegacyAuthHeaders(
          'POST',
          path,
          { ...EXPLORER_METADATA, Secret: 'a-shared-secret' },
          signWith(identity)
        )
      })

      // `secret` is declared because both comms handlers authorize on it. A spelling the handler
      // would read as absent is refused outright rather than folded into the canonical one.
      it('should respond with 400 and the declared-spelling error', async () => {
        const r = await localFetch.fetch(path, { method: 'POST', headers })

        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: expect.stringContaining('Invalid chain metadata: expected "secret", got "Secret"')
        })
      })
    })

    describe('and the auth chain is an EIP-1654 chain', () => {
      it('should use the mocked Catalyst validation response and respond with 200', async () => {
        const path = `/worlds/${worldName}/comms`
        const ownerAddress = identity.authChain.authChain[0].payload.toLowerCase()
        const catalystUrl = 'https://peer.decentraland.org/lambdas/crypto/validate-signature'
        const originalFetch = globalThis.fetch
        const catalystFetch = jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
          if (url === catalystUrl) {
            return Promise.resolve(new Response(JSON.stringify({ valid: true, ownerAddress }), { status: 200 }))
          }
          return originalFetch(url, init)
        })
        const chain: AuthChain = [
          { type: AuthLinkType.SIGNER, payload: ownerAddress, signature: '' },
          { type: AuthLinkType.ECDSA_EIP_1654_EPHEMERAL, payload: 'ephemeral', signature: 'signature' }
        ]

        try {
          const r = await localFetch.fetch(path, {
            method: 'POST',
            headers: getAuthHeaders('POST', path, EXPLORER_METADATA, () => chain)
          })

          expect(r.status).toEqual(200)
          expect(catalystFetch).toHaveBeenCalledWith(catalystUrl, expect.objectContaining({ method: 'POST' }))
        } finally {
          catalystFetch.mockRestore()
        }
      })
    })
  })

  describe('when requesting a scene room connection', () => {
    let localFetch: IAuthenticatedFetchComponent
    let worldsManager: IWorldsManager
    let identity: Identity
    let worldName: string
    let entityId: string

    beforeEach(async () => {
      localFetch = components.localFetch
      worldsManager = components.worldsManager
      identity = await getIdentity()

      const { worldCreator } = components
      const { namePermissionChecker } = stubComponents

      namePermissionChecker.checkPermission.mockResolvedValue(true)

      const created = await worldCreator.createWorldWithScene()
      worldName = created.worldName
      entityId = created.entityId
    })

    describe('and the request is valid', () => {
      it('should respond with 200 and the scene-specific connection string', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
        expect(await r.json()).toEqual({
          fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/scene-${worldName}-${entityId}`
        })
      })
    })

    describe('and the scene does not exist in the world', () => {
      it('should respond with 404 and the not-found error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/non-existent-scene-id/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('not found')
      })
    })

    describe('and the world does not exist', () => {
      let nonExistentWorld: string

      beforeEach(() => {
        const { worldCreator } = components
        nonExistentWorld = worldCreator.randomWorldName()
      })

      it('should respond with 404 and the invalid world error', async () => {
        const r = await localFetch.fetch(`/worlds/${nonExistentWorld}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(404)
        const body = await r.json()
        expect(body.error).toContain('invalid or blocked')
      })
    })

    describe('and the user has neither permission nor access', () => {
      beforeEach(async () => {
        const { namePermissionChecker } = stubComponents

        namePermissionChecker.checkPermission.mockResolvedValue(false)

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [],
          communities: []
        })
      })

      it('should respond with 401 and the not-allowed error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('not allowed to access')
      })
    })

    describe('and the user is banned from the scene', () => {
      beforeEach(() => {
        const { bans } = stubComponents as any
        bans.isUserBannedFromScene.mockResolvedValue(true)
      })

      it('should respond with 401 and the banned error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('banned')
      })
    })

    describe('and the user is platform-banned', () => {
      beforeEach(() => {
        const { bans } = stubComponents as any
        bans.isPlayerBanned.mockResolvedValue(true)
      })

      it('should respond with 401 and the platform-banned error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(401)
        const body = await r.json()
        expect(body.error).toContain('platform-banned')
      })
    })

    describe('and the scene was recently undeployed', () => {
      beforeEach(async () => {
        await worldsManager.undeployWorld(worldName)
      })

      it('should respond with 200', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the request is not signed', () => {
      it('should respond with 400 and the signed-fetch error', async () => {
        const r = await localFetch.fetch(`/worlds/${worldName}/scenes/${entityId}/comms`, {
          method: 'POST'
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toEqual({
          error: 'Invalid Auth Chain',
          message: 'This endpoint requires a signed fetch request. See ADR-44.'
        })
      })
    })
  })
})
