import { test } from '../components'
import { getIdentity, storeJson } from '../utils'
import { Authenticator } from '@dcl/crypto'

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
  it('returns acl from auth-chain when acl exists', async () => {
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
    expect(await r.json()).toMatchObject({
      resource: 'my-world.dcl.eth',
      allowed: [delegatedIdentity.realAccount.address]
    })
  })
})
