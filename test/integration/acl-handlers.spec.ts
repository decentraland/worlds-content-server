import { test } from '../components'
import { getIdentity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { streamToBuffer } from '@dcl/catalyst-storage'

test('acl handler GET /acl/:world_name', function ({ components, stubComponents }) {
  it('returns an empty acl when world does not exist', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/acl/my-world.dcl.eth')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: 'my-world.dcl.eth',
      allowed: [],
      timestamp: ''
    })
  })

  it('returns an empty acl when no acl exists', async () => {
    const { localFetch, worldCreator } = components

    const { worldName } = await worldCreator.createWorldWithScene()

    const r = await localFetch.fetch(`/acl/${worldName}`)

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: worldName,
      allowed: [],
      timestamp: ''
    })
  })

  it("returns an empty acl when existing acl is no longer the world owner's", async () => {
    const { localFetch, worldCreator, worldsManager } = components

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"`

    await worldsManager.storeAcl(worldName, Authenticator.signPayload(ownerIdentity.authChain, payload))

    const r = await localFetch.fetch(`/acl/${worldName}`)

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: worldName,
      allowed: [],
      timestamp: ''
    })
  })

  it('returns acl from auth-chain when acl exists', async () => {
    const { localFetch, worldCreator, worldsManager } = components
    const { namePermissionChecker } = stubComponents

    const delegatedIdentity = await getIdentity()
    const ownerIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    await worldsManager.storeAcl(worldName, Authenticator.signPayload(ownerIdentity.authChain, payload))

    namePermissionChecker.checkPermission
      .withArgs(ownerIdentity.authChain.authChain[0].payload, worldName)
      .resolves(true)

    const r = await localFetch.fetch(`/acl/${worldName}`)

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      resource: worldName,
      allowed: [delegatedIdentity.realAccount.address],
      timestamp: ts
    })
  })
})

test('acl handler POST /acl/:world_name', function ({ components, stubComponents }) {
  it('works when all is correct', async () => {
    const { localFetch, storage, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName, entity } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload, `${worldName}`)
      .resolves(true)

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    const signature = Authenticator.createSignature(identity.realAccount, payload)
    const acl = Authenticator.createSimpleAuthChain(payload, identity.realAccount.address, signature)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      resource: worldName,
      allowed: [delegatedIdentity.realAccount.address],
      timestamp: ts
    })

    const content = await storage.retrieve(`name-${worldName}`)
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({
      entityId: entity.id,
      runtimeMetadata: { name: worldName, entityIds: [entity.id] },
      acl
    })
  })

  it('stores the ACL in a file with the world name in lowercase when all is correct', async () => {
    const { localFetch, storage, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    const signature = Authenticator.createSignature(identity.realAccount, payload)
    const acl = Authenticator.createSimpleAuthChain(payload, identity.realAccount.address, signature)
    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      resource: worldName,
      allowed: [delegatedIdentity.realAccount.address],
      timestamp: ts
    })

    const content = await storage.retrieve(`name-${worldName}`)
    expect(content).toBeDefined()
    const stored = JSON.parse((await streamToBuffer(await content!.asStream())).toString())
    expect(stored).toMatchObject({ acl })
  })

  it('fails when resource is different than requested world', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"another-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Provided acl is for world "another-world.dcl.eth" but you are trying to set acl for world ${worldName}.`
    })
  })

  it('fails when name owner is part of the ACL', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${identity.realAccount.address}"],"timestamp":"${ts}"}`

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `You are trying to give permission to yourself. You own "${worldName}", so you already have permission to deploy scenes, no need to include yourself in the ACL.`
    })
  })

  it('fails when invalid acl (acl is not array)', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":{"something":"${delegatedIdentity.realAccount.address}"},"timestamp":"${ts}"}`

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Provided acl is invalid. allowed is missing or not an array of addresses.`
    })
  })

  it('fails when invalid acl (non address)', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["invalid"],"timestamp":"${ts}"}`

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Provided acl is invalid. allowed is missing or not an array of addresses.`
    })
  })

  it('fails when signer wallet does not own world name', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(false)

    const acl = Authenticator.signPayload(identity.authChain, payload)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(403)
    expect(await r.json()).toMatchObject({
      message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
    })
  })

  it('fails invalid payload sent', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(false)

    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify({}),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Invalid payload received. Need to be a valid AuthChain.`
    })
  })

  it('fails when missing timestamp', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"]}`

    const signature = Authenticator.createSignature(identity.realAccount, payload)
    const acl = Authenticator.createSimpleAuthChain(payload, identity.realAccount.address, signature)
    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Invalid ACL, timestamp is missing or has an invalid date.`
    })
  })

  it('fails when timestamp is too old', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const ts = new Date(Date.now() - 500_000).toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    const signature = Authenticator.createSignature(identity.realAccount, payload)
    const acl = Authenticator.createSimpleAuthChain(payload, identity.realAccount.address, signature)
    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Timestamp is not recent. Please sign a new ACL change request.`
    })
  })

  it('fails when timestamp is too far in the future', async () => {
    const { localFetch, worldCreator } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const ts = new Date(Date.now() + 500_000).toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    const signature = Authenticator.createSignature(identity.realAccount, payload)
    const acl = Authenticator.createSimpleAuthChain(payload, identity.realAccount.address, signature)
    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: `Timestamp is not recent. Please sign a new ACL change request.`
    })
  })

  it('fails when new timestamp is after currently stored ACL', async () => {
    const { localFetch, worldCreator, worldsManager } = components
    const { namePermissionChecker } = stubComponents

    const identity = await getIdentity()
    const delegatedIdentity = await getIdentity()

    const { worldName } = await worldCreator.createWorldWithScene()

    const ts = new Date().toISOString()
    const payload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${ts}"}`

    await worldsManager.storeAcl(worldName, Authenticator.signPayload(identity.authChain, payload))

    namePermissionChecker.checkPermission.withArgs(identity.authChain.authChain[0].payload, worldName).resolves(true)

    const newTs = new Date(Date.parse(ts) - 1).toISOString()
    const newPayload = `{"resource":"${worldName}","allowed":["${delegatedIdentity.realAccount.address}"],"timestamp":"${newTs}"}`

    const signature = Authenticator.createSignature(identity.realAccount, newPayload)
    const acl = Authenticator.createSimpleAuthChain(newPayload, identity.realAccount.address, signature)
    const r = await localFetch.fetch(`/acl/${worldName}`, {
      body: JSON.stringify(acl),
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toMatchObject({
      message: 'There is a newer ACL stored. Please sign a new ACL change request.'
    })
  })
})
