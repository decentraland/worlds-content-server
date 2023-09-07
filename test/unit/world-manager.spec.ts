import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { IWorldsManager, PermissionType } from '../../src/types'
import { readJson, storeJson } from '../utils'
import { defaultPermissions } from '../../src/logic/permissions-checker'

describe('WorldsManager', function () {
  let config: IConfigComponent
  let logs: ILoggerComponent
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager

  beforeEach(async () => {
    config = createConfigComponent({})
    logs = await createLogComponent({ config })
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerComponent({ logs, storage })
  })

  describe('addAddressToAllowList', () => {
    it('can add an address to an allow list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: defaultPermissions()
      })

      await worldsManager.addAddressToAllowList('world-name.dcl.eth', 'deployment', '0x1234')

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

      await expect(worldsManager.addAddressToAllowList('world-name.dcl.eth', 'access', '0x1234')).rejects.toThrow(
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

      await worldsManager.deleteAddressFromAllowList('world-name.dcl.eth', 'deployment', '0x1234')

      const stored = await readJson(storage, 'name-world-name.dcl.eth')
      expect(stored).toMatchObject({
        permissions: defaultPermissions()
      })
    })

    it('fails to remove an address when type is not allow-list', async () => {
      await storeJson(storage, 'name-world-name.dcl.eth', {
        permissions: defaultPermissions()
      })

      await expect(worldsManager.deleteAddressFromAllowList('world-name.dcl.eth', 'access', '0x1234')).rejects.toThrow(
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
})
