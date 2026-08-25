import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity, signWith } from '../utils'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'

/**
 * Pins that the scene gate cannot be walked past by re-spelling the key it reads.
 *
 * `rejectIfSigner` reads the own property `signer`. Metadata delivering `{"Signer":...}` therefore
 * presented no `signer` at all, and the gate answered "allowed" for a request that visibly names
 * the signer it exists to refuse.
 *
 * The two legacy-tolerant middleware instances declare `canonicalMetadataKeys`, and that guard
 * refuses a re-spelled key -- but only on the legacy path, which `verify()` consults *after* the
 * current-format check fails. Re-spelling a key is something a client simply signs: the bytes it
 * delivers are the bytes it signed, so the strict check verifies and the fallback is never reached.
 *
 * `signedFetchMiddleware` declares no keys at all, so on the routes below there was no guard on
 * either path -- which is why they are the ones covered here. @dcl/crypto-middleware 6.3.0 closes
 * it: a key case-folding to `signer` without being spelled exactly that is a rejection rather than
 * an absence. Nothing is folded; the request is refused, not rewritten.
 */
const STRICT_PATH = '/wallet/contribute'

/** The signer the explorer stamps on an auth chain signed on a scene's behalf. */
const SCENE_SIGNER = 'decentraland-kernel-scene'

/** Ordinary explorer metadata, minus the signer each case below supplies. */
const BASE_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  isGuest: 'false'
}

test('strict signed-fetch scene gate', function ({ components }) {
  describe('when a client signs the current 6.x payload for a route with no legacy fallback', () => {
    let localFetch: IAuthenticatedFetchComponent
    let identity: Identity

    beforeEach(async () => {
      localFetch = components.localFetch
      identity = await getIdentity()
    })

    describe('and the metadata carries no signer at all', () => {
      let headers: Record<string, string>

      beforeEach(() => {
        headers = getAuthHeaders('GET', STRICT_PATH, BASE_METADATA, signWith(identity))
      })

      it('should respond with 200, so ordinary wallet traffic is untouched by the gate', async () => {
        const r = await localFetch.fetch(STRICT_PATH, { method: 'GET', headers })

        expect(r.status).toEqual(200)
      })
    })

    describe('and the metadata names the scene signer under the declared spelling', () => {
      let headers: Record<string, string>

      beforeEach(() => {
        headers = getAuthHeaders('GET', STRICT_PATH, { ...BASE_METADATA, signer: SCENE_SIGNER }, signWith(identity))
      })

      it('should respond with 400 from the scene gate rather than reach the handler', async () => {
        const r = await localFetch.fetch(STRICT_PATH, { method: 'GET', headers })

        expect(r.status).toEqual(400)
      })
    })

    // The bypass, one spelling per case. Each of these is a validly signed request: the client chose
    // the key before signing, so the delivered bytes are the signed bytes and signature verification
    // has no objection to make. This instance declares no canonical keys, so nothing else was
    // looking -- the gate is the only thing standing between a scene-driven client and the handler.
    describe.each([['Signer'], ['SIGNER'], ['sIgNeR']])(
      'and the metadata names the scene signer under the key %p',
      (key) => {
        let headers: Record<string, string>

        beforeEach(() => {
          headers = getAuthHeaders('GET', STRICT_PATH, { ...BASE_METADATA, [key]: SCENE_SIGNER }, signWith(identity))
        })

        it('should respond with 400 rather than read the request as having no signer', async () => {
          const r = await localFetch.fetch(STRICT_PATH, { method: 'GET', headers })

          expect(r.status).toEqual(400)
        })
      }
    )
  })
})
