import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { IPermissionsManager, IWorldsManager, PermissionType } from '../../src/types'
import { readJson, storeJson } from '../utils'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { createWorldsManagerMockComponent } from '../mocks/worlds-manager-mock'
import { createPermissionsManagerComponent } from '../../src/adapters/permissions-manager'

describe('PermissionsManager', function () {
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager
  let permissionsManager: IPermissionsManager

  beforeEach(async () => {
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerMockComponent({ storage })
    permissionsManager = await createPermissionsManagerComponent({ worldsManager })
  })

  describe('addAddressToAllowList', () => {
    it('can add an address to an allow list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: defaultPermissions()
      })

      await permissionsManager.addAddressToAllowList('world-name.dcl.eth', 'deployment', '0x1234')

      const stored = await readJson(storage, 'name-world-name.dcl.eth')
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: ['0x1234']
          }
        }
      })
    })

    it('fails to add an address when type is not allow-list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: defaultPermissions()
      })

      await expect(permissionsManager.addAddressToAllowList('world-name.dcl.eth', 'access', '0x1234')).rejects.toThrow(
        'Permission access is not an allow list'
      )

      const stored = await readJson(storage, 'name-world-name.dcl.eth')
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions()
        }
      })
    })
  })

  describe('deleteAddressFromAllowList', () => {
    it('can remove an address from an allow list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: {
          ...defaultPermissions(),
          deployment: {
            type: PermissionType.AllowList,
            wallets: ['0x1234']
          }
        }
      })

      await permissionsManager.deleteAddressFromAllowList('world-name.dcl.eth', 'deployment', '0x1234')

      const stored = await readJson(storage, 'name-world-name.dcl.eth')
      expect(stored).toMatchObject({
        permissions: defaultPermissions()
      })
    })

    it('fails to remove an address when type is not allow-list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: defaultPermissions()
      })

      await expect(
        permissionsManager.deleteAddressFromAllowList('world-name.dcl.eth', 'access', '0x1234')
      ).rejects.toThrow('Permission access is not an allow list')

      const stored = await readJson(storage, 'name-world-name.dcl.eth')
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions()
        }
      })
    })
  })
})
