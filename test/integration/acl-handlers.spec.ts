import { test } from '../components'
import { getIdentity, storeJson } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'

test('acl handler GET /acl/:world_name', function ({ components }) {
  it('returns an error when world does not exists', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(404)
    expect(await r.text()).toEqual('World "my-world.dcl.eth" not deployed in this server.')
  })
})

test('acl handler GET /acl/:world_name', function ({ components }) {
  it('returns an empty list of allowed when no acl exists', async () => {
    const { localFetch, storage } = components

    await storeJson(
      storage,
      'name-my-world.dcl.eth',
      '{"entityId":"bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq"}'
    )

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: 'my-world.dcl.eth',
      allowed: []
    })
  })
})

test('acl handler GET /acl/:world_name', function ({ components }) {
  it('returns an empty list of allowed when existing acl is no longer the world owner', async () => {
    const { localFetch, storage } = components

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq',
      acl: Authenticator.signPayload(ownerIdentity.authChain, payload)
    })

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: 'my-world.dcl.eth',
      allowed: []
    })
  })
})

test('acl handler GET /acl/:world_name', function ({ components, stubComponents }) {
  it('returns acl from auth-chain when acl exists', async () => {
    const { localFetch, storage } = components
    const { namePermissionChecker } = stubComponents

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq',
      acl: Authenticator.signPayload(ownerIdentity.authChain, payload)
    })

    namePermissionChecker.checkPermission
      .withArgs(ownerIdentity.authChain.authChain[0].payload, 'my-world.dcl.eth')
      .resolves(true)

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({
      resource: 'my-world.dcl.eth',
      allowed: [delegatedIdentity.realAccount.address]
    })
  })
})

test('acl handler POST /acl/:world_name', function ({ components, stubComponents }) {
  it('works all is correct', async () => {
    const { localFetch, storage } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    })

    namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload, 'my-world.dcl.eth')
      .resolves(true)

    const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch('/acl/my-world.dcl.eth', {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      resource: 'my-world.dcl.eth',
      allowed: [delegatedIdentity.realAccount.address]
    })

    const content = await storage.retrieve('name-my-world.dcl.eth')
    const stored = JSON.parse((await streamToBuffer(await content.asStream())).toString())
    expect(stored).toMatchObject({
      entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq',
      acl: {
        resource: 'my-world.dcl.eth',
        allowed: [delegatedIdentity.realAccount.address]
      }
    })
  })
})

test('acl handler POST /acl/:world_name', function ({ components, stubComponents }) {
  it('fails when signer wallet does not own world name', async () => {
    const { localFetch, storage } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

    await storeJson(storage, 'name-my-world.dcl.eth', {
      entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq'
    })

    namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload, 'my-world.dcl.eth')
      .resolves(false)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch('/acl/my-world.dcl.eth', {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(403)
    expect(await r.json()).toEqual({
      message: `Your wallet does not own "my-world.dcl.eth", you can not set access control lists for it.`
    })
  })
})

test('acl handler POST /acl/:world_name', function ({ components, stubComponents }) {
  it('fails when the world name does not exist', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/acl/my-world.dcl.eth', {
      body: JSON.stringify({}),
      method: 'POST'
    })

    expect(r.status).toEqual(404)
    expect(await r.json()).toEqual({ message: `World "my-world.dcl.eth" not deployed in this server.` })
  })
})
