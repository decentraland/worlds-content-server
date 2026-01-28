import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent, IPermissionsManager, IWorldCreator } from '../../../src/types'
import { IPermissionsComponent } from '../../../src/logic/permissions'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:change-permissions',
  signer: 'dcl:builder',
  isGuest: 'false'
}

test('POST /world/:world_name/permissions/:permission_name/address/:address/parcels', ({
  components,
  stubComponents
}) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissionsManager: IPermissionsManager
  let permissions: IPermissionsComponent

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissionsManager = components.permissionsManager
    permissions = components.permissions

    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName

    stubComponents.namePermissionChecker.checkPermission
      .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), worldName)
      .resolves(true)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when the request is valid', () => {
    let targetAddress: Identity
    let parcelsToAdd: string[]
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      parcelsToAdd = ['0,0', '1,0', '1,1']
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 204 and create the permission with the parcels', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: parcelsToAdd })
      })

      expect(response.status).toBe(204)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        targetAddress.realAccount.address
      )
      expect(addressPermission).toBeDefined()

      const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
      expect(parcelsResult.total).toBe(3)
      expect(parcelsResult.results).toEqual(expect.arrayContaining(parcelsToAdd))
    })

    describe('and the address already has permission', () => {
      beforeEach(async () => {
        await permissionsManager.addParcelsToPermission(worldName, 'deployment', targetAddress.realAccount.address, [
          '2,2'
        ])
      })

      it('should respond with 204 and add the new parcels to the existing permission', async () => {
        const response = await localFetch.fetch(path, {
          method: 'POST',
          identity,
          metadata: BUILDER_METADATA,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parcels: parcelsToAdd })
        })

        expect(response.status).toBe(204)

        const addressPermission = await permissionsManager.getAddressPermissions(
          worldName,
          'deployment',
          targetAddress.realAccount.address
        )
        const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
        expect(parcelsResult.total).toBe(4)
        expect(parcelsResult.results).toEqual(expect.arrayContaining([...parcelsToAdd, '2,2']))
      })
    })
  })

  describe('when the address already has world-wide permission', () => {
    let targetAddress: Identity
    let parcelsToAdd: string[]
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      parcelsToAdd = ['0,0', '1,0', '1,1']
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`

      await permissions.grantWorldWidePermission(worldName, 'deployment', [targetAddress.realAccount.address])
    })

    it('should respond with 204 and add the parcels to the existing permission', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: parcelsToAdd })
      })

      expect(response.status).toBe(204)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        targetAddress.realAccount.address
      )
      expect(addressPermission).toBeDefined()

      const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
      expect(parcelsResult.total).toBe(3)
      expect(parcelsResult.results).toEqual(expect.arrayContaining(parcelsToAdd))
    })
  })

  describe('when the address is invalid', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/deployment/address/invalid-address/parcels`
    })

    it('should respond with 400 and an invalid address error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: ['0,0'] })
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid address: invalid-address.'
      })
    })
  })

  describe('when the permission name is invalid', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/invalid/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 400 and an invalid permission error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: ['0,0'] })
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: "Permission 'invalid' does not support allow-list. Only 'deployment' and 'streaming' do."
      })
    })
  })

  describe('when the parcels array is empty', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 400 and a validation error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: [] })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('when the parcels have invalid format', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 400 and a validation error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: ['invalid'] })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('when the caller is not the world owner', () => {
    let targetAddress: Identity
    let nonOwnerIdentity: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      nonOwnerIdentity = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 401 and a not authorized error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'POST',
        identity: nonOwnerIdentity,
        metadata: BUILDER_METADATA,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels: ['0,0'] })
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: 'Not Authorized',
        message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
      })
    })
  })
})
