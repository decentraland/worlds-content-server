import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { IPermissionsManager, IWorldCreator, IWorldsManager, PermissionType } from '../../src/types'
import { defaultPermissions } from '../../src/logic/permissions-checker'
import { createWorldsManagerMockComponent } from '../mocks/worlds-manager-mock'
import { createPermissionsManagerComponent } from '../../src/adapters/permissions-manager'
import { createWorldCreator } from '../mocks/world-creator'
import { getIdentity, Identity } from '../utils'

describe('PermissionsManager', function () {
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager
  let worldCreator: IWorldCreator
  let permissionsManager: IPermissionsManager
  let identity: Identity

  let worldName: string

  beforeEach(async () => {
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerMockComponent({ storage })
    worldCreator = createWorldCreator({ storage, worldsManager })
    permissionsManager = await createPermissionsManagerComponent({ worldsManager })
    identity = await getIdentity()

    const created = await worldCreator.createWorldWithScene()
    worldName = created.worldName
  })

  describe('addAddressToAllowList', () => {
    it('can add an address to an allow list', async () => {
      await permissionsManager.addAddressToAllowList(worldName, 'deployment', '0x1234')

      const stored = await worldsManager.getMetadataForWorld(worldName)
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

    it('can add an address even when the world does not exist', async () => {
      const worldName = worldCreator.randomWorldName()
      await permissionsManager.addAddressToAllowList(worldName, 'streaming', identity.realAccount.address)

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions(),
          streaming: {
            wallets: [identity.realAccount.address]
          }
        }
      })
    })

    it('fails to add an address when type is not allow-list', async () => {
      await expect(permissionsManager.addAddressToAllowList(worldName, 'access', '0x1234')).rejects.toThrow(
        'Permission access is not an allow list'
      )

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions()
        }
      })
    })
  })

  describe('deleteAddressFromAllowList', () => {
    it('can remove an address from an allow list', async () => {
      await worldsManager.storePermissions(worldName, {
        ...defaultPermissions(),
        deployment: {
          type: PermissionType.AllowList,
          wallets: ['0x1234']
        }
      })

      await permissionsManager.deleteAddressFromAllowList(worldName, 'deployment', '0x1234')

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        permissions: defaultPermissions()
      })
    })

    it('fails to remove an address when world does not exist', async () => {
      const worldName = worldCreator.randomWorldName()
      await expect(permissionsManager.deleteAddressFromAllowList(worldName, 'access', '0x1234')).rejects.toThrow(
        `World ${worldName} does not exist`
      )
    })

    it('fails to remove an address when type is not allow-list', async () => {
      await expect(permissionsManager.deleteAddressFromAllowList(worldName, 'access', '0x1234')).rejects.toThrow(
        'Permission access is not an allow list'
      )

      const stored = await worldsManager.getMetadataForWorld(worldName)
      expect(stored).toMatchObject({
        permissions: {
          ...defaultPermissions()
        }
      })
    })
  })
})
