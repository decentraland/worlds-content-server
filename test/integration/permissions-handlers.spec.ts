import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { IFetchComponent } from '@well-known-components/interfaces'
import { IWorldCreator, IWorldsManager, Permissions, PermissionType } from '../../src/types'
import bcrypt from 'bcrypt'

function makeRequest(
  localFetch: IFetchComponent,
  path: string,
  identity: Identity,
  extraMetadata: any = {},
  method: string = 'POST'
) {
  return localFetch.fetch(path, {
    method,
    headers: {
      ...getAuthHeaders(
        method,
        path,
        {
          origin: 'https://builder.decentraland.org',
          intent: 'dcl:builder:change-permissions',
          signer: 'dcl:builder',
          isGuest: 'false',
          ...extraMetadata
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

test('PermissionsHandler', function ({ components, stubComponents }) {
  let localFetch: IFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene()
    worldName = created.worldName

    stubComponents.namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
      .resolves(true)
  })

  describe('GET /world/:world_name/permissions', function () {
    it('returns an empty permission object when world does not exist', async () => {
      const worldName = worldCreator.randomWorldName()

      const r = await localFetch.fetch(`/world/${worldName}/permissions`)

      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ permissions: defaultPermissions() })
    })

    it('returns the stored permission object', async () => {
      const permissions: Permissions = {
        ...defaultPermissions(),
        access: {
          type: PermissionType.SharedSecret,
          secret: bcrypt.hashSync('some-super-secret-password', 10)
        },
        streaming: {
          type: PermissionType.AllowList,
          wallets: ['0xD9370c94253f080272BA1c28E216146ecE806d33', '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4']
        }
      }

      await worldsManager.storePermissions(worldName, permissions)

      const r = await localFetch.fetch(`/world/${worldName}/permissions`)

      expect(r.status).toBe(200)
      const json = await r.json()
      expect(json).toMatchObject({
        permissions: {
          ...permissions,
          access: {
            type: PermissionType.SharedSecret
          }
        }
      })
      expect(json.permissions.access.secret).toBeUndefined()
    })
  })

  describe('POST /world/my-world.dcl.eth/permissions/[:permission]', function () {
    describe('access permissions', () => {
      it('sets the access permissions to unrestricted', async () => {
        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          access: {
            type: PermissionType.SharedSecret,
            secret: expect.stringContaining('$2b$10$')
          }
        })

        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.Unrestricted
        })

        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            access: { type: PermissionType.Unrestricted }
          }
        })
      })

      it('sets the access permissions to shared-secret', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.SharedSecret,
          secret: 'some-super-secret-password'
        })

        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            access: {
              type: PermissionType.SharedSecret,
              secret: expect.stringContaining('$2b$10$')
            }
          }
        })
      })

      it('sets the access permissions to allow-list', async () => {
        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          deployment: { type: PermissionType.Unrestricted } as any
        })

        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.AllowList
        })
        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            access: { type: PermissionType.AllowList, wallets: [] }
          }
        })
      })

      it('sets the access permissions to nft-ownership', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.NFTOwnership,
          nft: 'urn:decentraland:some-nft'
        })
        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            access: { type: PermissionType.NFTOwnership, nft: 'urn:decentraland:some-nft' }
          }
        })
      })

      it('rejects when no type', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          secret: 'some-super-secret-password'
        })

        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid payload received. Need to provide a valid permission type: undefined.'
        })
      })

      it('rejects when invalid type', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: 'invalid',
          secret: 'some-super-secret-password'
        })
        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid payload received. Need to provide a valid permission type: invalid.'
        })
      })

      it('rejects when shared-secret but without a secret', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.SharedSecret
        })
        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid payload received. For shared secret there needs to be a valid secret.'
        })
      })

      it('rejects when nft-ownership but without an nft', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/access`, identity, {
          type: PermissionType.NFTOwnership
        })
        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: 'Invalid payload received. For nft ownership there needs to be a valid nft.'
        })
      })
    })

    describe('deployment permissions', () => {
      it('sets the deployment permissions to allow-list', async () => {
        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          deployment: { type: PermissionType.Unrestricted } as any
        })

        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/deployment`, identity, {
          type: PermissionType.AllowList
        })
        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            deployment: { type: PermissionType.AllowList, wallets: [] }
          }
        })
      })

      it("rejects when invalid permission check for 'deployment' permissions", async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/deployment`, identity, {
          type: PermissionType.SharedSecret,
          secret: 'some-secret'
        })
        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
        })
      })
    })

    describe('streaming permissions', () => {
      it('sets the streaming permissions to allow-list', async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/streaming`, identity, {
          type: PermissionType.AllowList
        })
        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            streaming: { type: PermissionType.AllowList, wallets: [] }
          }
        })
      })

      it('sets the streaming permissions to unrestricted', async () => {
        await worldsManager.storePermissions(worldName, {
          ...defaultPermissions(),
          streaming: { type: PermissionType.AllowList, wallets: [] }
        })

        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/streaming`, identity, {
          type: PermissionType.Unrestricted
        })
        expect(r.status).toBe(204)

        const metadata = await worldsManager.getMetadataForWorld(worldName)
        expect(metadata).toMatchObject({
          permissions: {
            streaming: { type: PermissionType.Unrestricted }
          }
        })
      })

      it("rejects when invalid permission check for 'streaming' permissions", async () => {
        const r = await makeRequest(localFetch, `/world/${worldName}/permissions/streaming`, identity, {
          type: PermissionType.SharedSecret,
          secret: 'some-secret'
        })
        expect(r.status).toEqual(400)
        expect(await r.json()).toMatchObject({
          error: 'Bad request',
          message: `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
        })
      })
    })

    it('rejects when not the owner of the world', async () => {
      const randomIdentity = await getIdentity()

      const r = await makeRequest(localFetch, `/world/${worldName}/permissions/streaming`, randomIdentity, {
        type: PermissionType.Unrestricted
      })
      expect(r.status).toEqual(401)
      expect(await r.json()).toMatchObject({
        error: 'Not Authorized',
        message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
      })
    })

    it('rejects non-signed fetch', async () => {
      const path = `/world/${worldName}/permissions/access`
      const r = await localFetch.fetch(path, {
        method: 'POST'
      })

      expect(await r.json()).toMatchObject({
        error: 'Invalid Auth Chain',
        message: 'This endpoint requires a signed fetch request. See ADR-44.'
      })
      expect(r.status).toEqual(400)
    })
  })

  describe(`PUT and DELETE /world/${worldName}/permissions/[:permission]/[:address]`, function () {
    let alreadyAllowedWallet: Identity

    beforeEach(async () => {
      alreadyAllowedWallet = await getIdentity()

      await worldsManager.storePermissions(worldName, {
        ...defaultPermissions(),
        deployment: {
          type: PermissionType.AllowList,
          wallets: [alreadyAllowedWallet.realAccount.address.toLowerCase()]
        }
      })
    })

    it('adds a new address to the allow list', async () => {
      const newAddressToAllow = await getIdentity()

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${newAddressToAllow.realAccount.address}`,
        identity,
        {},
        'PUT'
      )

      expect(r.status).toBe(204)
      expect(await r.text()).toEqual('')

      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata).toMatchObject({
        permissions: {
          deployment: {
            type: PermissionType.AllowList,
            wallets: [
              alreadyAllowedWallet.realAccount.address.toLowerCase(),
              newAddressToAllow.realAccount.address.toLowerCase()
            ]
          }
        }
      })
    })

    it('fails to add an invalid address to the allow list', async () => {
      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/anything`,
        identity,
        {},
        'PUT'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `Invalid address: anything.`
      })
    })

    it('fails to add an address to the allow list that already exists there', async () => {
      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`,
        identity,
        {},
        'PUT'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `World ${worldName} already has address ${alreadyAllowedWallet.realAccount.address} in the allow list for permission 'deployment'.`
      })
    })

    it('can add an address when the world does not exist yet', async () => {
      const worldName = worldCreator.randomWorldName()
      const newAddressToAllow = await getIdentity()
      stubComponents.namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
        .resolves(true)

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${newAddressToAllow.realAccount.address}`,
        identity,
        {},
        'PUT'
      )

      expect(r.status).toEqual(204)
      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata).toMatchObject({
        permissions: {
          deployment: {
            type: PermissionType.AllowList,
            wallets: [newAddressToAllow.realAccount.address.toLowerCase()]
          }
        }
      })
    })

    it('fails to add an address when permission type is not allow list', async () => {
      await worldsManager.storePermissions(worldName, {
        ...defaultPermissions(),
        access: { type: PermissionType.Unrestricted }
      })

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/access/${alreadyAllowedWallet.realAccount.address}`,
        identity,
        {},
        'PUT'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `World ${worldName} is configured as unrestricted (not 'allow-list') for permission 'access'.`
      })
    })

    it('removes an address from the allow list', async () => {
      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`,
        identity,
        {},
        'DELETE'
      )

      expect(await r.text()).toEqual('')
      expect(r.status).toBe(204)

      const metadata = await worldsManager.getMetadataForWorld(worldName)
      expect(metadata).toMatchObject({
        permissions: {
          deployment: {
            type: PermissionType.AllowList,
            wallets: []
          }
        }
      })
    })

    it('fails to remove an invalid address to the allow list', async () => {
      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/anything`,
        identity,
        {},
        'DELETE'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `Invalid address: anything.`
      })
    })

    it('fails to remove an address from the allow list that does not exists there', async () => {
      const addressToRemove = await getIdentity()

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${addressToRemove.realAccount.address}`,
        identity,
        {},
        'DELETE'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `World ${worldName} does not have address ${addressToRemove.realAccount.address} in the allow list for permission 'deployment'.`
      })
    })

    it('fails to remove an address when there is no permission type set', async () => {
      await worldsManager.storePermissions(worldName, {
        ...defaultPermissions(),
        deployment: undefined
      })

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`,
        identity,
        {},
        'DELETE'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `World ${worldName} does not have any permission type set for 'deployment'.`
      })
    })

    it('fails to remove an address when permission type is not allow list', async () => {
      await worldsManager.storePermissions(worldName, {
        ...defaultPermissions(),
        access: { type: PermissionType.Unrestricted }
      })

      const r = await makeRequest(
        localFetch,
        `/world/${worldName}/permissions/access/${alreadyAllowedWallet.realAccount.address}`,
        identity,
        {},
        'DELETE'
      )

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        error: 'Bad request',
        message: `World ${worldName} is configured as unrestricted (not 'allow-list') for permission 'access'.`
      })
    })
  })
})
