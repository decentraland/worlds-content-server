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

test('PUT /world/:world_name/permissions/:permission_name/:address', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissions: IPermissionsComponent
  let permissionsManager: IPermissionsManager

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissions = components.permissions
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

  describe('when the world has an existing allow list', () => {
    let alreadyAllowedWallet: Identity

    beforeEach(async () => {
      alreadyAllowedWallet = await getIdentity()

      await permissions.grantWorldWidePermission(worldName, 'deployment', [alreadyAllowedWallet.realAccount.address])
    })

    describe('and adding a new address', () => {
      let newAddressToAllow: Identity
      let path: string

      beforeEach(async () => {
        newAddressToAllow = await getIdentity()
        path = `/world/${worldName}/permissions/deployment/${newAddressToAllow.realAccount.address}`
      })

      it('should respond with 204 and add the address to the allow list', async () => {
        const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

        expect(response.status).toBe(204)
        expect(await response.text()).toEqual('')

        const hasPermission = await permissions.hasWorldWidePermission(
          worldName,
          'deployment',
          newAddressToAllow.realAccount.address
        )
        expect(hasPermission).toBe(true)
      })
    })

    describe('and the address already exists in the allow list', () => {
      let path: string

      beforeEach(() => {
        path = `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`
      })

      it('should respond with 204 (idempotent operation)', async () => {
        const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

        // The new API is idempotent - adding an existing address is a no-op
        expect(response.status).toBe(204)
      })
    })
  })

  describe('when the address has parcel-based deployment permission', () => {
    let addressWithParcels: Identity
    let existingParcels: string[]
    let path: string

    beforeEach(async () => {
      addressWithParcels = await getIdentity()
      existingParcels = ['0,0', '1,0', '1,1']
      path = `/world/${worldName}/permissions/deployment/${addressWithParcels.realAccount.address}`

      await permissionsManager.addParcelsToPermission(
        worldName,
        'deployment',
        addressWithParcels.realAccount.address,
        existingParcels
      )
    })

    it('should respond with 204, delete the parcels and make them a world-wide deployer', async () => {
      const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

      expect(response.status).toBe(204)

      const hasWorldWidePermission = await permissions.hasWorldWidePermission(
        worldName,
        'deployment',
        addressWithParcels.realAccount.address
      )
      expect(hasWorldWidePermission).toBe(true)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        addressWithParcels.realAccount.address
      )
      const parcelsResult = await permissionsManager.getParcelsForPermission(addressPermission!.id)
      expect(parcelsResult.total).toBe(0)
      expect(parcelsResult.results).toEqual([])
    })
  })

  describe('when the address is invalid', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/deployment/anything`
    })

    it('should respond with 400 and an invalid address error', async () => {
      const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid address: anything.'
      })
    })
  })

  describe('when the permission type is access (not allow-list based)', () => {
    let addressToAdd: Identity
    let path: string

    beforeEach(async () => {
      addressToAdd = await getIdentity()
      path = `/world/${worldName}/permissions/access/${addressToAdd.realAccount.address}`
    })

    it('should respond with 400 and a permission type error', async () => {
      const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: "Permission 'access' does not support allow-list. Only 'deployment' and 'streaming' do."
      })
    })
  })
})
