import { test } from '../components'
import { IAuthenticatedFetchComponent, IWorldCreator } from '../../src/types'
import { IPermissionsComponent } from '../../src/logic/permissions'
import { Identity, getIdentity } from '../utils'

const EXPLORER_METADATA = {
  origin: 'https://play.decentraland.org',
  intent: 'dcl:explorer:comms-handshake',
  signer: 'dcl:explorer',
  isGuest: 'false'
}

test('ContributorHandler', function ({ components }) {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissions: IPermissionsComponent
  let identity: Identity
  let worldName: string
  let owner: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissions = components.permissions

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName
    owner = created.owner.authChain[0].payload.toLowerCase()
  })

  describe('/wallet/contribute', () => {
    describe("when user doesn't have contributor permission to any world", () => {
      it('returns an empty list', async () => {
        const r = await localFetch.fetch('/wallet/contribute', {
          method: 'GET',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toBe(200)
        expect(await r.json()).toMatchObject({ domains: [], count: 0 })
      })
    })

    describe('when user has streamer permission to world', () => {
      it('returns list of domains', async () => {
        await permissions.grantWorldWidePermission(worldName, 'streaming', [identity.realAccount.address])

        const r = await localFetch.fetch('/wallet/contribute', {
          method: 'GET',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toBe(200)
        expect(await r.json()).toMatchObject({
          domains: [
            {
              name: worldName,
              user_permissions: ['streaming'],
              owner,
              size: '0'
            }
          ],
          count: 1
        })
      })
    })

    describe('when user has deployment permission to world', () => {
      it('returns list of domains', async () => {
        await permissions.grantWorldWidePermission(worldName, 'deployment', [identity.realAccount.address])

        const r = await localFetch.fetch('/wallet/contribute', {
          method: 'GET',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toBe(200)
        const result = await r.json()
        expect(result).toMatchObject({
          domains: [
            {
              name: worldName,
              user_permissions: ['deployment'],
              owner,
              size: '0'
            }
          ],
          count: 1
        })
      })
    })

    describe('when world streaming permission is unrestricted', () => {
      it('return empty list', async () => {
        // Default streaming is unrestricted - no permissions to grant
        const r = await localFetch.fetch('/wallet/contribute', {
          method: 'GET',
          identity,
          metadata: EXPLORER_METADATA
        })

        expect(r.status).toBe(200)
        const result = await r.json()
        expect(result).toMatchObject({
          domains: [],
          count: 0
        })
      })
    })
  })
})
