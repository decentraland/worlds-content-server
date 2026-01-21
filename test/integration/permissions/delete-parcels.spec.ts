import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent, IPermissionsManager, IWorldCreator } from '../../../src/types'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:change-permissions',
  signer: 'dcl:builder',
  isGuest: 'false'
}

test('DELETE /world/:world_name/permissions/:permission_name/address/:address/parcels', ({
  components,
  stubComponents
}) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissionsManager: IPermissionsManager

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissionsManager = components.permissionsManager

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
    let existingParcels: string[]
    let parcelsToRemove: string[]
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      existingParcels = ['0,0', '1,0', '1,1', '2,2']
      parcelsToRemove = ['0,0', '1,0']
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`

      await permissionsManager.addParcelsToPermission(
        worldName,
        'deployment',
        targetAddress.realAccount.address,
        existingParcels
      )
    })

    it('should respond with 204 and remove the specified parcels', async () => {
      const response = await localFetch.fetch(path, {
        method: 'DELETE',
        identity,
        metadata: BUILDER_METADATA,
        body: { parcels: parcelsToRemove }
      })

      expect(response.status).toBe(204)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        targetAddress.realAccount.address
      )
      const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
      expect(parcelsResult.total).toBe(2)
      expect(parcelsResult.results).toEqual(expect.arrayContaining(['1,1', '2,2']))
    })
  })

  describe('when all parcels are deleted from the permission', () => {
    let targetAddress: Identity
    let existingParcels: string[]
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      existingParcels = ['0,0', '1,0']
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`

      await permissionsManager.addParcelsToPermission(
        worldName,
        'deployment',
        targetAddress.realAccount.address,
        existingParcels
      )
    })

    it('should respond with 204 and keep the permission record with zero parcels', async () => {
      const response = await localFetch.fetch(path, {
        method: 'DELETE',
        identity,
        metadata: BUILDER_METADATA,
        body: { parcels: existingParcels }
      })

      expect(response.status).toBe(204)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        targetAddress.realAccount.address
      )
      expect(addressPermission).toBeDefined()

      const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
      expect(parcelsResult.total).toBe(0)
      expect(parcelsResult.results).toEqual([])
    })
  })

  describe('when the address does not have permission', () => {
    let targetAddress: Identity
    let path: string

    beforeEach(async () => {
      targetAddress = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/address/${targetAddress.realAccount.address}/parcels`
    })

    it('should respond with 400 and a permission not found error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'DELETE',
        identity,
        metadata: BUILDER_METADATA,
        body: { parcels: ['0,0'] }
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: `Permission not found. Address ${targetAddress.realAccount.address} does not have deployment permission for world ${worldName}.`
      })
    })
  })

  describe('when the address is invalid', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/deployment/address/invalid-address/parcels`
    })

    it('should respond with 400 and an invalid address error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'DELETE',
        identity,
        metadata: BUILDER_METADATA,
        body: { parcels: ['0,0'] }
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid address: invalid-address.'
      })
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

      await permissionsManager.addParcelsToPermission(worldName, 'deployment', targetAddress.realAccount.address, [
        '0,0'
      ])
    })

    it('should respond with 401 and a not authorized error', async () => {
      const response = await localFetch.fetch(path, {
        method: 'DELETE',
        identity: nonOwnerIdentity,
        metadata: BUILDER_METADATA,
        body: { parcels: ['0,0'] }
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: 'Not Authorized',
        message: `Your wallet does not own "${worldName}", you can not set access control lists for it.`
      })
    })
  })
})
