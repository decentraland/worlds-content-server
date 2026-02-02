import { test } from '../components'
import { IAuthenticatedFetchComponent, IWorldCreator } from '../../src/types'
import { IPermissionsComponent, PermissionType } from '../../src/logic/permissions'
import { IAccessComponent, AccessType } from '../../src/logic/access'
import { Identity, getIdentity } from '../utils'

test('PermissionsHandler', function ({ components }) {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissions: IPermissionsComponent
  let access: IAccessComponent
  let identity: Identity
  let ownerIdentity: Identity
  let worldName: string
  let owner: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissions = components.permissions
    access = components.access

    ownerIdentity = await getIdentity()
    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: ownerIdentity.authChain })
    worldName = created.worldName
    owner = created.owner.authChain[0].payload.toLowerCase()
  })

  describe('GET /world/:world_name/permissions/:permission_name', () => {
    describe('when getting access permission', () => {
      describe('and the access is unrestricted', () => {
        it('should return unrestricted access type', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/access`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({ type: AccessType.Unrestricted })
        })
      })

      describe('and the access is allow-list', () => {
        beforeEach(async () => {
          await access.setAccess(worldName, {
            type: AccessType.AllowList,
            wallets: ['0x1234567890123456789012345678901234567890']
          })
        })

        it('should return allow-list with wallets', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/access`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({
            type: AccessType.AllowList,
            wallets: ['0x1234567890123456789012345678901234567890'],
            communities: []
          })
        })
      })

      describe('and the access is allow-list with communities', () => {
        beforeEach(async () => {
          await access.setAccess(worldName, {
            type: AccessType.AllowList,
            wallets: ['0x1234567890123456789012345678901234567890'],
            communities: ['community-1', 'community-2']
          })
        })

        it('should return allow-list with wallets and communities', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/access`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({
            type: AccessType.AllowList,
            wallets: ['0x1234567890123456789012345678901234567890'],
            communities: ['community-1', 'community-2']
          })
        })
      })

      describe('and the access is shared-secret', () => {
        beforeEach(async () => {
          await access.setAccess(worldName, {
            type: AccessType.SharedSecret,
            secret: 'my-secret-password'
          })
        })

        it('should return shared-secret without the secret hash', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/access`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({ type: AccessType.SharedSecret })
          expect(body.secret).toBeUndefined()
        })
      })
    })

    describe('when getting deployment permission', () => {
      describe('and no wallets have deployment permission', () => {
        it('should return empty allow-list', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({
            type: PermissionType.AllowList,
            wallets: []
          })
        })
      })

      describe('and wallets have deployment permission', () => {
        beforeEach(async () => {
          await permissions.grantWorldWidePermission(worldName, 'deployment', [
            identity.realAccount.address.toLowerCase()
          ])
        })

        it('should return allow-list with wallets', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.type).toBe(PermissionType.AllowList)
          expect(body.wallets).toContain(identity.realAccount.address.toLowerCase())
        })
      })
    })

    describe('when getting streaming permission', () => {
      describe('and streaming is unrestricted (no entries)', () => {
        it('should return unrestricted', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body).toEqual({ type: PermissionType.Unrestricted })
        })
      })

      describe('and wallets have streaming permission', () => {
        beforeEach(async () => {
          await permissions.grantWorldWidePermission(worldName, 'streaming', [
            identity.realAccount.address.toLowerCase()
          ])
        })

        it('should return allow-list with wallets', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming`)

          expect(response.status).toBe(200)
          const body = await response.json()
          expect(body.type).toBe(PermissionType.AllowList)
          expect(body.wallets).toContain(identity.realAccount.address.toLowerCase())
        })
      })
    })

    describe('when getting an invalid permission name', () => {
      it('should return 400 with error message', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/invalid`)

        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.message).toContain('Invalid permission name')
      })
    })
  })

  describe('GET /world/:world_name/permissions/:permission_name/:address', () => {
    describe('when the request is not signed', () => {
      it('should return 400 with signed fetch error', async () => {
        const response = await localFetch.fetch(`/world/${worldName}/permissions/access/${owner}`)

        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.message).toContain('This endpoint requires a signed fetch request')
      })
    })

    describe('when the request is signed', () => {
      describe('when checking access permission', () => {
        describe('and the address is the owner', () => {
          it('should return 204', async () => {
            const response = await localFetch.fetch(`/world/${worldName}/permissions/access/${owner}`, {
              identity
            })

            expect(response.status).toBe(204)
          })
        })

        describe('and access is unrestricted', () => {
          it('should return 204 for any address', async () => {
            const response = await localFetch.fetch(
              `/world/${worldName}/permissions/access/${identity.realAccount.address}`,
              { identity }
            )

            expect(response.status).toBe(204)
          })
        })

        describe('and access is allow-list', () => {
          beforeEach(async () => {
            await access.setAccess(worldName, {
              type: AccessType.AllowList,
              wallets: [identity.realAccount.address.toLowerCase()]
            })
          })

          describe('and the address is in the allow-list', () => {
            it('should return 204', async () => {
              const response = await localFetch.fetch(
                `/world/${worldName}/permissions/access/${identity.realAccount.address}`,
                { identity }
              )

              expect(response.status).toBe(204)
            })
          })

          describe('and the address is not in the allow-list', () => {
            it('should return 403', async () => {
              const otherIdentity = await getIdentity()
              const response = await localFetch.fetch(
                `/world/${worldName}/permissions/access/${otherIdentity.realAccount.address}`,
                { identity }
              )

              expect(response.status).toBe(403)
              const body = await response.json()
              expect(body.error).toBe('Forbidden')
            })
          })
        })
      })

      describe('when checking deployment permission', () => {
        describe('and the address is the owner', () => {
          it('should return 204', async () => {
            const response = await localFetch.fetch(`/world/${worldName}/permissions/deployment/${owner}`, {
              identity
            })

            expect(response.status).toBe(204)
          })
        })

        describe('and the address has world-wide deployment permission', () => {
          beforeEach(async () => {
            await permissions.grantWorldWidePermission(worldName, 'deployment', [
              identity.realAccount.address.toLowerCase()
            ])
          })

          it('should return 204', async () => {
            const response = await localFetch.fetch(
              `/world/${worldName}/permissions/deployment/${identity.realAccount.address}`,
              { identity }
            )

            expect(response.status).toBe(204)
          })
        })

        describe('and the address does not have deployment permission', () => {
          it('should return 403', async () => {
            const response = await localFetch.fetch(
              `/world/${worldName}/permissions/deployment/${identity.realAccount.address}`,
              { identity }
            )

            expect(response.status).toBe(403)
            const body = await response.json()
            expect(body.error).toBe('Forbidden')
          })
        })
      })

      describe('when checking streaming permission', () => {
        describe('and the address is the owner', () => {
          it('should return 204', async () => {
            const response = await localFetch.fetch(`/world/${worldName}/permissions/streaming/${owner}`, {
              identity
            })

            expect(response.status).toBe(204)
          })
        })

        describe('and the address has streaming permission', () => {
          beforeEach(async () => {
            await permissions.grantWorldWidePermission(worldName, 'streaming', [
              identity.realAccount.address.toLowerCase()
            ])
          })

          it('should return 204', async () => {
            const response = await localFetch.fetch(
              `/world/${worldName}/permissions/streaming/${identity.realAccount.address}`,
              { identity }
            )

            expect(response.status).toBe(204)
          })
        })

        describe('and streaming is unrestricted and address does not have explicit permission', () => {
          it('should return 403', async () => {
            const response = await localFetch.fetch(
              `/world/${worldName}/permissions/streaming/${identity.realAccount.address}`,
              { identity }
            )

            expect(response.status).toBe(403)
          })
        })
      })

      describe('when checking an invalid permission name', () => {
        it('should return 400 with error message', async () => {
          const response = await localFetch.fetch(
            `/world/${worldName}/permissions/invalid/${identity.realAccount.address}`,
            { identity }
          )

          expect(response.status).toBe(400)
          const body = await response.json()
          expect(body.message).toContain('Invalid permission name')
        })
      })

      describe('when checking with an invalid address', () => {
        it('should return 400 with error message', async () => {
          const response = await localFetch.fetch(`/world/${worldName}/permissions/access/invalid-address`, {
            identity
          })

          expect(response.status).toBe(400)
          const body = await response.json()
          expect(body.message).toContain('Invalid address')
        })
      })
    })
  })
})
