import { test } from '../components'
import { getIdentity, Identity } from '../utils'
import { Authenticator } from '@dcl/crypto'
import { IFetchComponent } from '@well-known-components/http-server'
import { IWorldCreator, IWorldsManager, PermissionType } from '../../src/types'
import { defaultPermissions } from '../../src/logic/permissions-checker'

test('acl handlers', function ({ components, stubComponents }) {
  let localFetch: IFetchComponent
  let worldCreator: IWorldCreator
  let worldsManager: IWorldsManager

  let ownerIdentity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    worldsManager = components.worldsManager

    ownerIdentity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: ownerIdentity.authChain })
    worldName = created.worldName

    stubComponents.namePermissionChecker.checkPermission
      .withArgs(ownerIdentity.authChain.authChain[0].payload, worldName)
      .resolves(true)
  })

  describe('GET /acl/:world_name', () => {
    it('returns an empty acl when world does not exist', async () => {
      const worldName = worldCreator.randomWorldName()
      const r = await localFetch.fetch(`/acl/${worldName}`)

      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        resource: worldName,
        allowed: [],
        timestamp: ''
      })
    })

    it('returns an empty acl when no acl exists', async () => {
      const r = await localFetch.fetch(`/acl/${worldName}`)

      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        resource: worldName,
        allowed: [],
        timestamp: ''
      })
    })

    it('returns acl from auth-chain when acl exists', async () => {
      const delegatedIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: new Date().toISOString()
      })

      await worldsManager.storeAcl(worldName, Authenticator.signPayload(ownerIdentity.authChain, payload))
      const r = await localFetch.fetch(`/acl/${worldName}`)

      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: ''
      })
    })
  })

  describe('POST /acl/:world_name', function () {
    it('works when all is correct', async () => {
      const delegatedIdentity = await getIdentity()

      const timestamp = new Date().toISOString()
      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, payload)
      const acl = Authenticator.createSimpleAuthChain(payload, ownerIdentity.realAccount.address, signature)

      const r = await localFetch.fetch(`/acl/${worldName}`, {
        body: JSON.stringify(acl),
        method: 'POST'
      })

      expect(r.status).toEqual(200)
      expect(await r.json()).toEqual({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: timestamp
      })

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        acl,
        permissions: {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: [delegatedIdentity.realAccount.address]
          },
          streaming: {
            type: PermissionType.AllowList,
            wallets: [delegatedIdentity.realAccount.address]
          }
        }
      })
    })

    it('stores the ACL in a file with the world name in lowercase when all is correct', async () => {
      const delegatedIdentity = await getIdentity()

      const timestamp = new Date().toISOString()
      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, payload)
      const acl = Authenticator.createSimpleAuthChain(payload, ownerIdentity.realAccount.address, signature)
      const r = await localFetch.fetch(`/acl/${worldName}`, {
        body: JSON.stringify(acl),
        method: 'POST'
      })

      expect(r.status).toEqual(200)
      expect(await r.json()).toEqual({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: timestamp
      })

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        acl,
        permissions: {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: [delegatedIdentity.realAccount.address]
          },
          streaming: {
            type: PermissionType.AllowList,
            wallets: [delegatedIdentity.realAccount.address]
          }
        }
      })
    })

    it('fails when resource is different than requested world', async () => {
      const delegatedIdentity = await getIdentity()

      const anotherWorldName = worldCreator.randomWorldName()
      const payload = JSON.stringify({
        resource: anotherWorldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: new Date().toISOString()
      })

      const r = await localFetch.fetch(`/acl/${worldName}`, {
        body: JSON.stringify(Authenticator.signPayload(ownerIdentity.authChain, payload)),
        method: 'POST'
      })

      expect(r.status).toEqual(400)
      expect(await r.json()).toMatchObject({
        message: `Provided acl is for world "${anotherWorldName}" but you are trying to set acl for world ${worldName}.`
      })
    })

    it('fails when name owner is part of the ACL', async () => {
      const payload = JSON.stringify({
        resource: worldName,
        allowed: [ownerIdentity.realAccount.address],
        timestamp: new Date().toISOString()
      })

      const acl = Authenticator.signPayload(ownerIdentity.authChain, payload)

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
      const delegatedIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: { something: delegatedIdentity.realAccount.address },
        timestamp: new Date().toISOString()
      })

      const acl = Authenticator.signPayload(ownerIdentity.authChain, payload)

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
      const payload = JSON.stringify({
        resource: worldName,
        allowed: ['invalid'],
        timestamp: new Date().toISOString()
      })

      const acl = Authenticator.signPayload(ownerIdentity.authChain, payload)

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
      const nonOwnerIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: [(await getIdentity()).realAccount.address],
        timestamp: new Date().toISOString()
      })
      const acl = Authenticator.signPayload(nonOwnerIdentity.authChain, payload)

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
      const delegatedIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address]
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, payload)
      const acl = Authenticator.createSimpleAuthChain(payload, ownerIdentity.realAccount.address, signature)
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
      const delegatedIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: new Date(Date.now() - 500_000).toISOString()
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, payload)
      const acl = Authenticator.createSimpleAuthChain(payload, ownerIdentity.realAccount.address, signature)
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
      const delegatedIdentity = await getIdentity()

      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: new Date(Date.now() + 500_000).toISOString()
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, payload)
      const acl = Authenticator.createSimpleAuthChain(payload, ownerIdentity.realAccount.address, signature)
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
      const delegatedIdentity = await getIdentity()

      const ts = new Date().toISOString()
      const payload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: ts
      })

      await worldsManager.storeAcl(worldName, Authenticator.signPayload(ownerIdentity.authChain, payload))

      const newPayload = JSON.stringify({
        resource: worldName,
        allowed: [delegatedIdentity.realAccount.address],
        timestamp: new Date(Date.parse(ts) - 1).toISOString()
      })

      const signature = Authenticator.createSignature(ownerIdentity.realAccount, newPayload)
      const acl = Authenticator.createSimpleAuthChain(newPayload, ownerIdentity.realAccount.address, signature)
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
})
