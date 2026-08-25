import { test } from '../../components'
import { getIdentity, getLegacyAuthHeaders, Identity, signWith } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IWorldCreator, IWorldsManager } from '../../../src/types'
import { AccessType } from '../../../src/logic/access'

/**
 * Pins that creator-hub can still set world permissions.
 *
 * It signs the pre-6.0.0 folded payload -- it resolves decentraland-crypto-fetch 2.0.1 -- while
 * delivering the metadata header verbatim, and it is the only caller that sends metadata to this
 * route. Everything it sends here carries uppercase, so under 6.x every one of these calls 401s.
 *
 * Unlike the builder and the CLI, it cannot be sequenced ahead of the deploy: it is a shipped
 * Electron desktop app, so old builds keep calling after this service updates.
 *
 * Note what creator-hub does *not* send: no `signer`, no `intent`. The metadata is exactly
 * `{ type, ...options }`.
 */
const PASSWORD = 'MyPassWord123'

test('POST /world/:world_name/permissions/:permission_name with the pre-6.0.0 folded payload', ({
  components,
  stubComponents
}) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager

  let identity: Identity
  let worldName: string
  let path: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName
    path = `/world/${worldName}/permissions/access`

    stubComponents.namePermissionChecker.checkPermission.mockImplementation(
      async (ethAddress, name) =>
        ethAddress === identity.authChain.authChain[0].payload.toLowerCase() && name === worldName
    )
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  /**
   * Rewrites one key's spelling while keeping every key in place.
   *
   * Order matters: the folded payload covers the serialized metadata, so moving a key changes the
   * signed bytes and the request would fail on the signature instead of on the spelling under test.
   */
  function respell(metadata: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key === from ? to : key, value]))
  }

  describe('when creator-hub sets a shared-secret password containing uppercase', () => {
    let headers: Record<string, string>

    beforeEach(() => {
      // The exact metadata `postPermissionType` builds for the password dialog. The dialog requires
      // digits and a minimum length and never normalizes case -- the same modal lowercases wallet
      // addresses two functions down, so the secret keeping its casing is deliberate.
      headers = getLegacyAuthHeaders(
        'POST',
        path,
        { type: AccessType.SharedSecret, secret: PASSWORD },
        signWith(identity)
      )
    })

    it('should respond with 204 rather than refuse the signature', async () => {
      const response = await localFetch.fetch(path, { method: 'POST', headers })

      expect(response.status).toEqual(204)
    })

    it('should store the access as shared-secret', async () => {
      await localFetch.fetch(path, { method: 'POST', headers })

      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata?.access).toMatchObject({ type: AccessType.SharedSecret })
    })
  })

  describe('when an allow list carries an uppercase community id', () => {
    let headers: Record<string, string>

    beforeEach(() => {
      // The second vector on this route: the CSV import form matches community ids with a
      // case-insensitive regex and pushes the value verbatim, while lowercasing wallet addresses on
      // the line above. An uppercase id makes the fold lossy exactly as the password does.
      headers = getLegacyAuthHeaders(
        'POST',
        path,
        { type: AccessType.AllowList, wallets: [], communities: ['B7B1E0D2-0000-4000-8000-000000000001'] },
        signWith(identity)
      )
    })

    it('should get past signed-fetch verification rather than be refused by it', async () => {
      const response = await localFetch.fetch(path, { method: 'POST', headers })

      // What the handler then decides about an unknown community is a separate question; the point
      // is that the request is no longer refused before reaching it.
      expect(response.status).not.toEqual(401)
    })
  })

  describe.each([
    ['secret', 'Secret'],
    ['type', 'Type'],
    ['wallets', 'Wallets'],
    ['communities', 'Communities']
  ])('when %s is delivered under the re-cased key %s', (declared, respelled) => {
    let headers: Record<string, string>

    beforeEach(() => {
      // Folded, this signs identically to the same object spelling the key canonically, so only the
      // declared-key guard can refuse it. Read as absent, the handler would write an access setting
      // the owner never asked for.
      //
      // Re-spelled in place rather than added alongside: order is part of the folded bytes, and a
      // metadata carrying both spellings would be refused as ambiguous instead of on the spelling
      // under test.
      const metadata = {
        type: AccessType.AllowList,
        secret: 'a-shared-secret',
        wallets: [],
        communities: []
      }
      headers = getLegacyAuthHeaders('POST', path, respell(metadata, declared, respelled), signWith(identity))
    })

    it('should respond with 400 and the declared-spelling error rather than write the access', async () => {
      const response = await localFetch.fetch(path, { method: 'POST', headers })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(`Invalid chain metadata: expected "${declared}", got "${respelled}"`)
      })
    })
  })

  describe('when the request carries the scene signer', () => {
    let headers: Record<string, string>

    beforeEach(() => {
      headers = getLegacyAuthHeaders(
        'POST',
        path,
        { type: AccessType.Unrestricted, signer: 'decentraland-kernel-scene' },
        signWith(identity)
      )
    })

    it('should respond with 400, so the fallback has not widened who may call', async () => {
      const response = await localFetch.fetch(path, { method: 'POST', headers })

      expect(response.status).toEqual(400)
    })
  })

  describe('when the scene signer is delivered under a re-cased key', () => {
    let headers: Record<string, string>

    beforeEach(() => {
      // No lowercase `signer` at all, so the scene gate would read the field as absent while the
      // folded signature stays valid.
      headers = getLegacyAuthHeaders(
        'POST',
        path,
        { type: AccessType.Unrestricted, Signer: 'decentraland-kernel-scene' },
        signWith(identity)
      )
    })

    it('should respond with 400 and the declared-spelling error', async () => {
      const response = await localFetch.fetch(path, { method: 'POST', headers })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('Invalid chain metadata: expected "signer", got "Signer"')
      })
    })
  })
})
