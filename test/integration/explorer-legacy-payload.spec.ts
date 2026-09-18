import { test } from '../components'
import { getIdentity, getLegacyAuthHeaders, Identity, signWith } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'

// The metadata the unity, godot and bevy explorers send on a comms handshake.
const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

/**
 * The three routes wired to `explorerSignedFetchMiddleware`, the only ones that accept the
 * pre-6.0.0 folded payload. Kept as one table so adding a fourth route to that middleware without
 * covering it here fails visibly rather than quietly.
 *
 * Paths are built per-test because the world and scene are created in `beforeEach`.
 */
const EXPLORER_ROUTES = [
  {
    name: 'the world comms route',
    path: (world: string) => `/worlds/${world}/comms`,
    room: (world: string) => `world-${world}`
  },
  {
    name: 'the scene comms route',
    path: (world: string, entityId: string) => `/worlds/${world}/scenes/${entityId}/comms`,
    room: (world: string, entityId: string) => `scene-${world}-${entityId}`
  },
  {
    name: 'the comms adapter route',
    path: (world: string) => `/get-comms-adapter/world-${world}`,
    room: (world: string) => `world-${world}`
  }
]

test('explorer legacy signed payload', function ({ components, stubComponents }) {
  describe('when an explorer signs the pre-6.0.0 folded payload', () => {
    let localFetch: IAuthenticatedFetchComponent
    let identity: Identity
    let worldName: string
    let entityId: string

    beforeEach(async () => {
      localFetch = components.localFetch
      identity = await getIdentity()

      const { worldCreator } = components
      const { config, namePermissionChecker } = stubComponents

      // The adapter route resolves its room through these; the comms routes do not need them.
      const requireStringValues: Record<string, string> = {
        LIVEKIT_HOST: 'livekit.org',
        LIVEKIT_API_KEY: 'livekit_key',
        LIVEKIT_API_SECRET: 'livekit_secret',
        COMMS_ROOM_PREFIX: 'world-'
      }
      config.requireString.mockImplementation(async (name) => requireStringValues[name] ?? '')
      namePermissionChecker.checkPermission.mockResolvedValue(true)

      const created = await worldCreator.createWorldWithScene()
      worldName = created.worldName
      entityId = created.entityId
    })

    describe.each(EXPLORER_ROUTES)('and the request targets $name', (route) => {
      let path: string
      let expectedRoom: string

      beforeEach(() => {
        path = route.path(worldName, entityId)
        expectedRoom = route.room(worldName, entityId)
      })

      describe('and every declared key is spelled canonically', () => {
        let headers: Record<string, string>

        beforeEach(() => {
          headers = getLegacyAuthHeaders('POST', path, EXPLORER_METADATA, signWith(identity))
        })

        // `isGuest` alone makes folding the metadata lossy, so the current-format check cannot
        // verify this payload and the request falls through to the declared-key fallback.
        it('should accept the handshake and respond with the connection string', async () => {
          const r = await localFetch.fetch(path, { method: 'POST', headers })

          expect(r.status).toEqual(200)
          expect(await r.json()).toEqual({
            fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/${expectedRoom}`
          })
        })
      })

      describe('and the scene signer is delivered under a re-cased key', () => {
        let headers: Record<string, string>

        beforeEach(() => {
          // No lowercase `signer` at all, so the scene gate would read the field as absent. Folded,
          // this metadata signs identically to the same object spelling the key `signer`.
          const { signer: _omitted, ...withoutSigner } = EXPLORER_METADATA
          headers = getLegacyAuthHeaders(
            'POST',
            path,
            { ...withoutSigner, Signer: 'decentraland-kernel-scene' },
            signWith(identity)
          )
        })

        // Two guards refuse this and the earlier one answers. Since @dcl/crypto-middleware 6.3.0
        // `rejectIfSigner` treats a key case-folding to `signer` as a rejection rather than an
        // absence, and `metadataValidator` runs ahead of signature verification -- so the scene
        // gate replies before `assertLegacyMetadataKeys` is consulted. The declared-key guard still
        // refuses it a step later; what the gate adds is the current-format path, where the
        // declared keys are never looked at. Both are 400s.
        it('should respond with 400 from the scene gate rather than run the handshake', async () => {
          const r = await localFetch.fetch(path, { method: 'POST', headers })

          expect(r.status).toEqual(400)
          expect(await r.json()).toMatchObject({
            error: expect.stringContaining('Invalid metadata content')
          })
        })
      })

      describe('and secret is delivered under a re-cased key', () => {
        let headers: Record<string, string>

        beforeEach(() => {
          headers = getLegacyAuthHeaders(
            'POST',
            path,
            { ...EXPLORER_METADATA, Secret: 'a-shared-secret' },
            signWith(identity)
          )
        })

        // Both comms handlers authorize on `secret`, so a spelling they would read as absent is
        // refused outright rather than folded into the canonical one.
        it('should respond with 400 and the declared-spelling error', async () => {
          const r = await localFetch.fetch(path, { method: 'POST', headers })

          expect(r.status).toEqual(400)
          expect(await r.json()).toMatchObject({
            error: expect.stringContaining('Invalid chain metadata: expected "secret", got "Secret"')
          })
        })
      })

      describe('and intent is delivered under a re-cased key', () => {
        let headers: Record<string, string>

        beforeEach(() => {
          const { intent: _omitted, ...withoutIntent } = EXPLORER_METADATA
          headers = getLegacyAuthHeaders(
            'POST',
            path,
            { ...withoutIntent, Intent: 'dcl:explorer:comms-handshake' },
            signWith(identity)
          )
        })

        // Declared because comms-adapter-handler compares it. Guarded on all three routes rather
        // than only that one: the declaration is per-middleware, not per-route.
        it('should respond with 400 and the declared-spelling error', async () => {
          const r = await localFetch.fetch(path, { method: 'POST', headers })

          expect(r.status).toEqual(400)
          expect(await r.json()).toMatchObject({
            error: expect.stringContaining('Invalid chain metadata: expected "intent", got "Intent"')
          })
        })
      })

      describe('and an undeclared key is delivered re-cased', () => {
        let headers: Record<string, string>

        beforeEach(() => {
          const { isGuest: _omitted, ...withoutIsGuest } = EXPLORER_METADATA
          headers = getLegacyAuthHeaders('POST', path, { ...withoutIsGuest, ISGUEST: 'false' }, signWith(identity))
        })

        // States the boundary of the guarantee rather than leaving it implied: the guard covers the
        // keys this service reads and nothing else. `isGuest` is sent by the explorers but never
        // read here, so its spelling cannot change an authorization decision and is not policed.
        it('should accept the handshake, since no authorization decision reads that field', async () => {
          const r = await localFetch.fetch(path, { method: 'POST', headers })

          expect(r.status).toEqual(200)
          expect(await r.json()).toEqual({
            fixedAdapter: `ws-room:ws-room-service.decentraland.org/rooms/${expectedRoom}`
          })
        })
      })
    })
  })
})
