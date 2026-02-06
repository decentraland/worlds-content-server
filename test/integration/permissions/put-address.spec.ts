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

test('PUT /world/:world_name/permissions/:permission_name/:address', ({ components, stubComponents }) => {
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

  describe('when the world does not exist', () => {
    let nonExistentWorldName: string
    let addressToAllow: Identity

    beforeEach(async () => {
      nonExistentWorldName = worldCreator.randomWorldName()
      addressToAllow = await getIdentity()

      stubComponents.namePermissionChecker.checkPermission
        .withArgs(identity.authChain.authChain[0].payload.toLowerCase(), nonExistentWorldName)
        .resolves(true)
    })

    it('should create the world and respond with 204', async () => {
      const path = `/world/${nonExistentWorldName}/permissions/deployment/${addressToAllow.realAccount.address}`
      const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

      expect(response.status).toBe(204)

      const exists = await worldsManager.worldExists(nonExistentWorldName)
      expect(exists).toBe(true)

      const hasPermission = await permissions.hasWorldWidePermission(
        nonExistentWorldName,
        'deployment',
        addressToAllow.realAccount.address
      )
      expect(hasPermission).toBe(true)
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

  describe('when the permission type is access', () => {
    describe('and the world has allow-list access', () => {
      let addressToAdd: Identity
      let path: string

      beforeEach(async () => {
        addressToAdd = await getIdentity()
        path = `/world/${worldName}/permissions/access/${addressToAdd.realAccount.address}`

        await worldsManager.storeAccess(worldName, {
          type: AccessType.AllowList,
          wallets: ['0x1234567890123456789012345678901234567890'],
          communities: []
        })
      })

      it('should respond with 204 and add the wallet to the access allow list', async () => {
        const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

        expect(response.status).toBe(204)
        expect(await response.text()).toEqual('')

        const accessSetting = await access.getAccessForWorld(worldName)
        expect(accessSetting.type).toBe(AccessType.AllowList)
        if (accessSetting.type === AccessType.AllowList) {
          expect(accessSetting.wallets).toContain(addressToAdd.realAccount.address.toLowerCase())
        }
      })

      describe('and the wallet is already in the access allow list', () => {
        beforeEach(async () => {
          await worldsManager.storeAccess(worldName, {
            type: AccessType.AllowList,
            wallets: [addressToAdd.realAccount.address.toLowerCase()],
            communities: []
          })
        })

        it('should respond with 204 (idempotent operation)', async () => {
          const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

          expect(response.status).toBe(204)
        })
      })
    })

    describe('and the world does not have allow-list access', () => {
      let addressToAdd: Identity
      let path: string

      beforeEach(async () => {
        addressToAdd = await getIdentity()
        path = `/world/${worldName}/permissions/access/${addressToAdd.realAccount.address}`

        await worldsManager.storeAccess(worldName, {
          type: AccessType.Unrestricted
        })
      })

      it('should respond with 400 and a not allow-list error', async () => {
        const response = await localFetch.fetch(path, { method: 'PUT', identity, metadata: BUILDER_METADATA })

        expect(response.status).toEqual(400)
        expect(await response.json()).toMatchObject({
          error: 'Bad request',
          message: expect.stringContaining('does not have allow-list access type')
        })
      })
    })
  })
})
