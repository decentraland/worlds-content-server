import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { IAuthenticatedFetchComponent } from '../../components/local-auth-fetch'
import { IPermissionsManager, IWorldCreator, IWorldsManager } from '../../../src/types'
import { IPermissionsComponent } from '../../../src/logic/permissions'
import { AccessType, IAccessComponent } from '../../../src/logic/access'

const BUILDER_METADATA = {
  origin: 'https://builder.decentraland.org',
  intent: 'dcl:builder:change-permissions',
  signer: 'dcl:builder',
  isGuest: 'false'
}

test('DELETE /world/:world_name/permissions/:permission_name/:address', ({ components, stubComponents }) => {
  let localFetch: IAuthenticatedFetchComponent
  let worldCreator: IWorldCreator
  let permissions: IPermissionsComponent
  let permissionsManager: IPermissionsManager
  let worldsManager: IWorldsManager
  let access: IAccessComponent

  let identity: Identity
  let worldName: string

  beforeEach(async () => {
    localFetch = components.localFetch
    worldCreator = components.worldCreator
    permissions = components.permissions
    permissionsManager = components.permissionsManager
    worldsManager = components.worldsManager
    access = components.access

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

  describe('when the address exists in the allow list', () => {
    let alreadyAllowedWallet: Identity
    let path: string

    beforeEach(async () => {
      alreadyAllowedWallet = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/${alreadyAllowedWallet.realAccount.address}`

      await permissions.grantWorldWidePermission(worldName, 'deployment', [alreadyAllowedWallet.realAccount.address])
    })

    it('should respond with 204 and remove the address from the allow list', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(await response.text()).toEqual('')
      expect(response.status).toBe(204)

      const hasPermission = await permissions.hasWorldWidePermission(
        worldName,
        'deployment',
        alreadyAllowedWallet.realAccount.address
      )
      expect(hasPermission).toBe(false)
    })
  })

  describe('when the address has parcel-based permission', () => {
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

    it('should respond with 204 and revoke the permission entirely including all parcels', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(response.status).toBe(204)

      const addressPermission = await permissionsManager.getAddressPermissions(
        worldName,
        'deployment',
        addressWithParcels.realAccount.address
      )
      expect(addressPermission).toBeUndefined()
    })
  })

  describe('when the address is invalid', () => {
    let path: string

    beforeEach(() => {
      path = `/world/${worldName}/permissions/deployment/anything`
    })

    it('should respond with 400 and an invalid address error', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      expect(response.status).toEqual(400)
      expect(await response.json()).toMatchObject({
        error: 'Bad request',
        message: 'Invalid address: anything.'
      })
    })
  })

  describe('when the address does not exist in the allow list', () => {
    let addressToRemove: Identity
    let path: string

    beforeEach(async () => {
      addressToRemove = await getIdentity()
      path = `/world/${worldName}/permissions/deployment/${addressToRemove.realAccount.address}`

      // Add a different address to the allow list
      const alreadyAllowedWallet = await getIdentity()
      await permissions.grantWorldWidePermission(worldName, 'deployment', [alreadyAllowedWallet.realAccount.address])
    })

    it('should respond with 204 (idempotent operation)', async () => {
      const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

      // The new API is idempotent - removing a non-existent address is a no-op
      expect(response.status).toBe(204)
    })
  })

  describe('when the permission type is access', () => {
    describe('and the world has allow-list access', () => {
      let addressToRemove: Identity
      let path: string

      beforeEach(async () => {
        addressToRemove = await getIdentity()
        path = `/world/${worldName}/permissions/access/${addressToRemove.realAccount.address}`

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: [addressToRemove.realAccount.address.toLowerCase(), '0x1234567890123456789012345678901234567890'],
          communities: []
        })
      })

      it('should respond with 204 and remove the wallet from the access allow list', async () => {
        const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

        expect(response.status).toBe(204)
        expect(await response.text()).toEqual('')

        const accessSetting = await access.getAccessForWorld(worldName)
        expect(accessSetting.type).toBe(AccessType.AllowList)
        if (accessSetting.type === AccessType.AllowList) {
          expect(accessSetting.wallets).not.toContain(addressToRemove.realAccount.address.toLowerCase())
          expect(accessSetting.wallets).toContain('0x1234567890123456789012345678901234567890')
        }
      })

      describe('and the wallet is not in the access allow list', () => {
        let differentAddress: Identity

        beforeEach(async () => {
          differentAddress = await getIdentity()
          path = `/world/${worldName}/permissions/access/${differentAddress.realAccount.address}`
        })

        it('should respond with 204 (idempotent operation)', async () => {
          const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

          expect(response.status).toBe(204)
        })
      })
    })

    describe('and the world does not have allow-list access', () => {
      let addressToRemove: Identity
      let path: string

      beforeEach(async () => {
        addressToRemove = await getIdentity()
        path = `/world/${worldName}/permissions/access/${addressToRemove.realAccount.address}`

        await worldsManager.storeAccess(worldName, {
          type: AccessType.Unrestricted
        })
      })

      it('should respond with 400 and a not allow-list error', async () => {
        const response = await localFetch.fetch(path, { method: 'DELETE', identity, metadata: BUILDER_METADATA })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: expect.stringContaining('does not have allow-list access type')
        })
      })
    })
  })
})
