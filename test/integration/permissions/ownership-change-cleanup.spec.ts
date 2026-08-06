import { test } from '../../components'
import { getIdentity, Identity } from '../../utils'
import { INameOwnership, IPermissionsManager, IWorldCreator } from '../../../src/types'

test('permissions cleanup after a world changes owners', ({ components }) => {
  const previousOwner = '0xa100000000000000000000000000000000000001'
  const newOwner = '0xb200000000000000000000000000000000000002'

  let permissionsManager: IPermissionsManager
  let worldCreator: IWorldCreator
  let nameOwnership: jest.Mocked<INameOwnership>

  let identity: Identity
  let worldName: string
  let grantedByPreviousOwner: Identity
  let grantedByNewOwner: Identity

  beforeEach(async () => {
    permissionsManager = components.permissionsManager
    worldCreator = components.worldCreator
    nameOwnership = components.nameOwnership

    identity = await getIdentity()
    const created = await worldCreator.createWorldWithScene({ owner: identity.authChain })
    worldName = created.worldName

    grantedByPreviousOwner = await getIdentity()
    grantedByNewOwner = await getIdentity()

    // The previous owner hands out a permission while the name is still theirs.
    nameOwnership.findOwners.mockResolvedValue(new Map([[worldName, previousOwner]]))
    await permissionsManager.grantAddressesWorldWidePermission(worldName, 'deployment', [
      grantedByPreviousOwner.realAccount.address
    ])

    // The name is transferred, and the new owner grants a permission of their own before the
    // update owner job gets a chance to run.
    nameOwnership.findOwners.mockResolvedValue(new Map([[worldName, newOwner]]))
    await permissionsManager.grantAddressesWorldWidePermission(worldName, 'deployment', [
      grantedByNewOwner.realAccount.address
    ])
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when deleting the permissions that were not granted under the new owner', () => {
    let remainingAddresses: string[]

    beforeEach(async () => {
      await permissionsManager.deletePermissionsNotGrantedUnderOwner(worldName, newOwner)
      const records = await permissionsManager.getWorldPermissionRecords(worldName)
      remainingAddresses = records.map((record) => record.address)
    })

    it('should remove the permission the previous owner had granted', () => {
      expect(remainingAddresses).not.toContain(grantedByPreviousOwner.realAccount.address.toLowerCase())
    })

    it('should keep the permission the new owner granted after the transfer', () => {
      expect(remainingAddresses).toEqual([grantedByNewOwner.realAccount.address.toLowerCase()])
    })
  })

  describe('when the new owner re-granted a permission the previous owner had already granted', () => {
    let remainingAddresses: string[]

    beforeEach(async () => {
      await permissionsManager.grantAddressesWorldWidePermission(worldName, 'deployment', [
        grantedByPreviousOwner.realAccount.address
      ])

      await permissionsManager.deletePermissionsNotGrantedUnderOwner(worldName, newOwner)
      const records = await permissionsManager.getWorldPermissionRecords(worldName)
      remainingAddresses = records.map((record) => record.address)
    })

    it('should keep the re-granted permission', () => {
      expect(remainingAddresses).toContain(grantedByPreviousOwner.realAccount.address.toLowerCase())
    })
  })

  describe('when the previous owner had granted a permission scoped to parcels', () => {
    let parcelHolder: Identity
    let remainingAddresses: string[]

    beforeEach(async () => {
      parcelHolder = await getIdentity()

      nameOwnership.findOwners.mockResolvedValue(new Map([[worldName, previousOwner]]))
      await permissionsManager.addParcelsToPermission(worldName, 'deployment', parcelHolder.realAccount.address, [
        '20,24'
      ])

      await permissionsManager.deletePermissionsNotGrantedUnderOwner(worldName, newOwner)
      const records = await permissionsManager.getWorldPermissionRecords(worldName)
      remainingAddresses = records.map((record) => record.address)
    })

    it('should remove the parcel scoped permission as well', () => {
      expect(remainingAddresses).not.toContain(parcelHolder.realAccount.address.toLowerCase())
    })
  })

  describe('when the owner a permission was granted under could not be resolved', () => {
    let unknownProvenanceHolder: Identity
    let remainingAddresses: string[]

    beforeEach(async () => {
      unknownProvenanceHolder = await getIdentity()

      nameOwnership.findOwners.mockResolvedValue(new Map())
      await permissionsManager.grantAddressesWorldWidePermission(worldName, 'deployment', [
        unknownProvenanceHolder.realAccount.address
      ])

      await permissionsManager.deletePermissionsNotGrantedUnderOwner(worldName, newOwner)
      const records = await permissionsManager.getWorldPermissionRecords(worldName)
      remainingAddresses = records.map((record) => record.address)
    })

    it('should remove the permission of unknown provenance', () => {
      expect(remainingAddresses).not.toContain(unknownProvenanceHolder.realAccount.address.toLowerCase())
    })
  })
})
