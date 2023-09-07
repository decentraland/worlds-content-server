import { test } from '../components'
import { getAuthHeaders, getIdentity, Identity, makeid, storeJson } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { streamToBuffer } from '@dcl/catalyst-storage'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { IFetchComponent } from '@well-known-components/http-server'
import { PermissionType } from '../../src/types'
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

test('permissions handler GET /world/:world_name/permissions', function ({ components }) {
  it('returns an empty permission object when world does not exist', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/world/my-world.dcl.eth/permissions')

    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ permissions: defaultPermissions() })
  })

  it('returns the stored permission object', async () => {
    const { localFetch, storage } = components

    const entityId = 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    const permissions = {
      deployment: {
        type: PermissionType.AllowList,
        wallets: []
      },
      access: {
        type: PermissionType.SharedSecret,
        secret: bcrypt.hashSync('some-super-secret-password', 10)
      },
      streaming: {
        type: PermissionType.AllowList,
        wallets: ['0xD9370c94253f080272BA1c28E216146ecE806d33', '0xb7DF441676bf3bDb13ad622ADE983d84f86B0df4']
      }
    }
    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId,
      runtimeMetadata: { name: 'my-world.dcl.eth', entityIds: [entityId] },
      permissions: permissions
    })

    const r = await localFetch.fetch('/world/my-world.dcl.eth/permissions')

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

test('permissions handler POST /world/my-world.dcl.eth/permissions/[:permission]', function ({
  components,
  stubComponents
}) {
  let identity: Identity

  beforeEach(async () => {
    const { storage } = components
    const { namePermissionChecker } = stubComponents

    identity = await getIdentity()

    for await (const key of components.storage.allFileIds('name-')) {
      await storage.delete([key])
    }

    namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), 'my-world.dcl.eth')
      .resolves(true)
  })

  it('sets the access permissions to shared-secret', async () => {
    const { localFetch, storage } = components

    const entityId = 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId,
      runtimeMetadata: { name: 'my-world.dcl.eth', entityIds: [entityId] },
      permissions: defaultPermissions()
    })

    const path = '/world/my-world.dcl.eth/permissions/access'

    const r = await makeRequest(localFetch, path, identity, {
      type: PermissionType.SharedSecret,
      secret: 'some-super-secret-password'
    })
    expect(r.status).toBe(204)

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      entityId,
      runtimeMetadata: { name: 'my-world.dcl.eth', entityIds: [entityId] },
      permissions: {
        access: {
          type: PermissionType.SharedSecret,
          secret: expect.stringContaining('$2b$10$')
        }
      }
    })
  })

  it('sets the deployment permissions to allow-list', async () => {
    const { localFetch, storage } = components

    const entityId = 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId,
      permissions: {
        ...defaultPermissions(),
        deployment: { type: PermissionType.Unrestricted }
      }
    })

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/deployment', identity, {
      type: PermissionType.AllowList
    })
    expect(r.status).toBe(204)

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      permissions: {
        deployment: { type: PermissionType.AllowList, wallets: [] }
      }
    })
  })

  it('sets the access permissions to nft-ownership', async () => {
    const { localFetch, storage } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/access', identity, {
      type: PermissionType.NFTOwnership,
      nft: 'urn:decentraland:some-nft'
    })
    expect(r.status).toBe(204)

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      permissions: {
        access: { type: PermissionType.NFTOwnership, nft: 'urn:decentraland:some-nft' }
      }
    })
  })

  it('sets the deployment permissions to allow-list', async () => {
    const { localFetch, storage } = components

    const entityId = 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId,
      permissions: {
        ...defaultPermissions(),
        deployment: { type: PermissionType.Unrestricted }
      }
    })

    const path = '/world/my-world.dcl.eth/permissions/deployment'

    const r = await makeRequest(localFetch, path, identity, {
      type: PermissionType.AllowList
    })
    expect(r.status).toBe(204)

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      permissions: {
        deployment: { type: PermissionType.AllowList, wallets: [] }
      }
    })
  })

  it('sets the streaming permissions to allow-list', async () => {
    const { localFetch, storage } = components

    const entityId = 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId,
      permissions: defaultPermissions()
    })

    const path = '/world/my-world.dcl.eth/permissions/streaming'

    const r = await makeRequest(localFetch, path, identity, {
      type: PermissionType.AllowList
    })
    expect(r.status).toBe(204)

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      permissions: {
        streaming: { type: PermissionType.AllowList, wallets: [] }
      }
    })
  })

  it('rejects when no type', async () => {
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/access', identity, {
      secret: 'some-super-secret-password'
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      error: 'Bad request',
      message: 'Invalid payload received. Need to provide a valid permission type: undefined.'
    })
  })

  it('rejects when invalid type', async () => {
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/access', identity, {
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
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/access', identity, {
      type: PermissionType.SharedSecret
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      error: 'Bad request',
      message: 'Invalid payload received. For shared secret there needs to be a valid secret.'
    })
  })

  it('rejects when nft-ownership but without an nft', async () => {
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/access', identity, {
      type: PermissionType.NFTOwnership
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      error: 'Bad request',
      message: 'Invalid payload received. For nft ownership there needs to be a valid nft.'
    })
  })

  it("rejects when invalid permission check for 'deployment' permissions", async () => {
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/deployment', identity, {
      type: PermissionType.SharedSecret,
      secret: 'some-secret'
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      error: 'Bad request',
      message: `Invalid payload received. Deployment permission needs to be '${PermissionType.AllowList}'.`
    })
  })

  it("rejects when invalid permission check for 'deployment' permissions", async () => {
    const { localFetch } = components

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/streaming', identity, {
      type: PermissionType.SharedSecret,
      secret: 'some-secret'
    })
    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      error: 'Bad request',
      message: `Invalid payload received. Streaming permission needs to be either '${PermissionType.Unrestricted}' or '${PermissionType.AllowList}'.`
    })
  })

  it('rejects when not the owner of the world', async () => {
    const { localFetch } = components
    const { namePermissionChecker } = stubComponents

    namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), 'my-world.dcl.eth')
      .resolves(false)

    const r = await makeRequest(localFetch, '/world/my-world.dcl.eth/permissions/streaming', identity, {
      type: PermissionType.Unrestricted
    })
    expect(r.status).toEqual(403)
    expect(await r.json()).toMatchObject({
      error: 'Access denied',
      message: 'Your wallet does not own "my-world.dcl.eth", you can not set access control lists for it.'
    })
  })

  it('rejects non-signed fetch', async () => {
    const { localFetch } = components

    const path = '/world/my-world.dcl.eth/permissions/access'
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

test('permissions handler PUT and DELETE /world/my-world.dcl.eth/permissions/[:permission]/[:address]', function ({
  components,
  stubComponents
}) {
  let identity: Identity
  let alreadyAllowedWallet: Identity
  let worldName: string

  beforeEach(async () => {
    const { storage } = components
    const { namePermissionChecker } = stubComponents

    identity = await getIdentity()
    alreadyAllowedWallet = await getIdentity()
    worldName = `${makeid(10)}.dcl.eth`

    for await (const key of components.storage.allFileIds('name-')) {
      await storage.delete([key])
    }

    await storeJson(storage, `name-${worldName}`, {
      permissions: {
        ...defaultPermissions(),
        deployment: {
          type: PermissionType.AllowList,
          wallets: [alreadyAllowedWallet.realAccount.address.toLowerCase()]
        }
      }
    })

    namePermissionChecker.checkPermission.withArgs(identity.realAccount.address.toLowerCase(), worldName).resolves(true)
  })

  it('adds a new address to the allow list', async () => {
    const { localFetch, storage } = components

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

    const content = await storage.retrieve(`name-${worldName}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
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

  it('fails to add an address to the allow list that already exists there', async () => {
    const { localFetch } = components

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
      message: `World ${worldName} already has address ${alreadyAllowedWallet.realAccount.address.toLowerCase()} in the allow list for permission 'deployment'.`
    })
  })

  it('removes an address from the allow list', async () => {
    const { localFetch, storage } = components

    const r = await makeRequest(
      localFetch,
      `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`,
      identity,
      {},
      'DELETE'
    )

    expect(await r.text()).toEqual('')
    expect(r.status).toBe(204)

    const content = await storage.retrieve(`name-${worldName}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      permissions: {
        deployment: {
          type: PermissionType.AllowList,
          wallets: []
        }
      }
    })
  })

  it('fails to remove an address from the allow list that does not exists there', async () => {
    const { localFetch } = components

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
      message: `World ${worldName} does not have address ${addressToRemove.realAccount.address.toLowerCase()} in the allow list for permission 'deployment'.`
    })
  })
})
