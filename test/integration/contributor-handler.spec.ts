import { Authenticator } from '@dcl/crypto'
import { test } from '../components'
import { IWorldCreator, IWorldsManager, Permissions, PermissionType } from '../../src/types'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { Identity, getIdentity, getAuthHeaders } from '../utils'

test('ContributorHandler', function ({ components }) {
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager
  let identity: Identity
  let worldName: string
  let owner: string

  function makeRequest(path: string, identity: Identity) {
    return components.localFetch.fetch(path, {
      method: 'GET',
      headers: {
        ...getAuthHeaders(
          'get',
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

  beforeEach(async () => {
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName
    owner = created.owner.authChain[0].payload.toLowerCase()
  })

  describe('/wallet/contribute', () => {
    describe("when user doesn't have contributor permission to any world", () => {
      it('returns an empty list', async () => {
        const r = await makeRequest('/wallet/contribute', identity)

        expect(r.status).toBe(200)
        expect(await r.json()).toMatchObject({ domains: [], count: 0 })
      })
    })

    describe('when user has streamer permission to world', () => {
      it('returns list of domains', async () => {
        const permissions: Permissions = {
          ...defaultPermissions(),
          streaming: {
            type: PermissionType.AllowList,
            wallets: [identity.realAccount.address]
          }
        }
        await worldsManager.storePermissions(worldName, permissions)
        const r = await makeRequest('/wallet/contribute', identity)

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

    describe('when user has access permission to world', () => {
      it('returns list of domains', async () => {
        const permissions: Permissions = {
          ...defaultPermissions(),
          access: {
            type: PermissionType.AllowList,
            wallets: [identity.realAccount.address]
          }
        }
        await worldsManager.storePermissions(worldName, permissions)
        const r = await makeRequest('/wallet/contribute', identity)

        expect(r.status).toBe(200)
        expect(await r.json()).toMatchObject({
          domains: [
            {
              name: worldName,
              user_permissions: ['access'],
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
        const permissions: Permissions = {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: [identity.realAccount.address]
          }
        }

        await worldsManager.storePermissions(worldName, permissions)
        const r = await makeRequest('/wallet/contribute', identity)

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
        const permissions: Permissions = {
          ...defaultPermissions(),
          streaming: {
            type: PermissionType.Unrestricted
          }
        }

        await worldsManager.storePermissions(worldName, permissions)
        const r = await makeRequest('/wallet/contribute', identity)

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
