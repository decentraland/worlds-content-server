import { createPermissionsComponent } from '../../src/logic/permissions/component'
import {
  IPermissionsComponent,
  PermissionType,
  WorldPermissionRecordForChecking
} from '../../src/logic/permissions/types'
import { InvalidPermissionRequestError, PermissionNotFoundError } from '../../src/logic/permissions/errors'
import { IPermissionsManager } from '../../src/types'
import { IConfigComponent } from '@well-known-components/interfaces'
import { IPublisherComponent } from '@dcl/sns-component'
import { createMockedPermissionsManager } from '../mocks/permissions-manager-mock'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockedSnsClient } from '../mocks/sns-client-mock'

describe('PermissionsComponent', () => {
  let permissionsComponent: IPermissionsComponent
  let permissionsManager: jest.Mocked<IPermissionsManager>
  let config: jest.Mocked<IConfigComponent>
  let snsClient: jest.Mocked<IPublisherComponent>

  beforeEach(async () => {
    permissionsManager = createMockedPermissionsManager()

    config = createMockedConfig()
    config.requireString.mockImplementation((key: string) => {
      if (key === 'BUILDER_URL') return Promise.resolve('https://builder.example.com')
      return Promise.resolve('')
    })

    snsClient = createMockedSnsClient()
    snsClient.publishMessages.mockResolvedValue({
      successfulMessageIds: ['test-message-id'],
      failedEvents: []
    })

    permissionsComponent = await createPermissionsComponent({
      config,
      permissionsManager,
      snsClient
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking world wide permissions', () => {
    describe('and the address has world-wide permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x1234',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      it('should return true', async () => {
        const result = await permissionsComponent.hasWorldWidePermission('test-world', 'deployment', '0x1234')
        expect(result).toBe(true)
      })
    })

    describe('and the address has parcel-specific permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x1234',
            isWorldWide: false,
            parcelCount: 5,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      it('should return false', async () => {
        const result = await permissionsComponent.hasWorldWidePermission('test-world', 'deployment', '0x1234')
        expect(result).toBe(false)
      })
    })

    describe('and the address has no permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([])
      })

      it('should return false', async () => {
        const result = await permissionsComponent.hasWorldWidePermission('test-world', 'deployment', '0x1234')
        expect(result).toBe(false)
      })
    })

    describe('and checking with different case address', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0xabcd',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      it('should match case-insensitively', async () => {
        const result = await permissionsComponent.hasWorldWidePermission('test-world', 'deployment', '0xABCD')
        expect(result).toBe(true)
      })
    })
  })

  describe('when checking permissions for specific parcels', () => {
    describe('and the address has world-wide permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x1234',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      it('should return true for any parcels', async () => {
        const result = await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', [
          '0,0',
          '1,0',
          '2,0'
        ])
        expect(result).toBe(true)
      })

      it('should not check parcels in the database', async () => {
        await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', ['0,0', '1,0', '2,0'])
        expect(permissionsManager.checkParcelsAllowed).not.toHaveBeenCalled()
      })
    })

    describe('and the address has parcel-specific permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValue([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x1234',
            isWorldWide: false,
            parcelCount: 5,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      describe('and all requested parcels are allowed', () => {
        beforeEach(() => {
          permissionsManager.checkParcelsAllowed.mockResolvedValueOnce(true)
        })

        it('should return true', async () => {
          const result = await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', [
            '0,0',
            '1,0'
          ])
          expect(result).toBe(true)
        })

        it('should check the correct parcels in the database', async () => {
          await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', ['0,0', '1,0'])
          expect(permissionsManager.checkParcelsAllowed).toHaveBeenCalledWith(1, ['0,0', '1,0'])
        })
      })

      describe('and not all requested parcels are allowed', () => {
        beforeEach(() => {
          permissionsManager.checkParcelsAllowed.mockResolvedValueOnce(false)
        })

        it('should return false', async () => {
          const result = await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', [
            '0,0',
            '99,99'
          ])
          expect(result).toBe(false)
        })
      })
    })

    describe('and the address has no permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValue([])
      })

      it('should return false', async () => {
        const result = await permissionsComponent.hasPermissionForParcels('test-world', 'deployment', '0x1234', ['0,0'])
        expect(result).toBe(false)
      })
    })
  })

  describe('when granting world wide permissions', () => {
    describe('and granting to new addresses', () => {
      beforeEach(() => {
        permissionsManager.grantAddressesWorldWidePermission.mockResolvedValueOnce(['0x1234', '0x5678'])
      })

      it('should grant permission to the addresses', async () => {
        await permissionsComponent.grantWorldWidePermission('test-world', 'deployment', ['0x1234', '0x5678'])

        expect(permissionsManager.grantAddressesWorldWidePermission).toHaveBeenCalledWith('test-world', 'deployment', [
          '0x1234',
          '0x5678'
        ])
      })

      it('should send batched notifications to all added addresses', async () => {
        await permissionsComponent.grantWorldWidePermission('test-world', 'deployment', ['0x1234', '0x5678'])
        expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x1234' })
            }),
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x5678' })
            })
          ])
        )
      })
    })

    describe('and some addresses already have permission', () => {
      beforeEach(() => {
        permissionsManager.grantAddressesWorldWidePermission.mockResolvedValueOnce(['0x5678'])
      })

      it('should only send notifications to newly added addresses', async () => {
        await permissionsComponent.grantWorldWidePermission('test-world', 'deployment', ['0x1234', '0x5678'])
        expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x5678' })
            })
          ])
        )
      })
    })

    describe('and the wallets array is empty', () => {
      it('should not call the manager', async () => {
        await permissionsComponent.grantWorldWidePermission('test-world', 'deployment', [])
        expect(permissionsManager.grantAddressesWorldWidePermission).not.toHaveBeenCalled()
      })

      it('should not send notifications', async () => {
        await permissionsComponent.grantWorldWidePermission('test-world', 'deployment', [])
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })

  describe('when revoking permissions', () => {
    describe('and revoking from addresses with permission', () => {
      beforeEach(() => {
        permissionsManager.removeAddressesPermission.mockResolvedValueOnce(['0x1234', '0x5678'])
      })

      it('should revoke permission from the addresses', async () => {
        await permissionsComponent.revokePermission('test-world', 'deployment', ['0x1234', '0x5678'])

        expect(permissionsManager.removeAddressesPermission).toHaveBeenCalledWith('test-world', 'deployment', [
          '0x1234',
          '0x5678'
        ])
      })

      it('should send batched notifications to all revoked addresses', async () => {
        await permissionsComponent.revokePermission('test-world', 'deployment', ['0x1234', '0x5678'])
        expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x1234' })
            }),
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x5678' })
            })
          ])
        )
      })
    })

    describe('and some addresses do not have permission', () => {
      beforeEach(() => {
        permissionsManager.removeAddressesPermission.mockResolvedValueOnce(['0x5678'])
      })

      it('should only send notifications to actually revoked addresses', async () => {
        await permissionsComponent.revokePermission('test-world', 'deployment', ['0x1234', '0x5678'])
        expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x5678' })
            })
          ])
        )
      })
    })

    describe('and the addresses array is empty', () => {
      it('should not call the manager', async () => {
        await permissionsComponent.revokePermission('test-world', 'deployment', [])
        expect(permissionsManager.removeAddressesPermission).not.toHaveBeenCalled()
      })

      it('should not send notifications', async () => {
        await permissionsComponent.revokePermission('test-world', 'deployment', [])
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })

  describe('when setting deployment permissions', () => {
    describe('and setting allow-list permission', () => {
      let existingRecords: WorldPermissionRecordForChecking[]

      beforeEach(() => {
        existingRecords = [
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0xold1',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 2,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0xold2',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ]
        permissionsManager.getWorldPermissionRecords.mockResolvedValue(existingRecords)
        permissionsManager.removeAddressesPermission.mockResolvedValue(['0xold1'])
        permissionsManager.grantAddressesWorldWidePermission.mockResolvedValue(['0xnew1'])
      })

      it('should remove old wallets not in the new list', async () => {
        await permissionsComponent.setDeploymentPermission('test-world', PermissionType.AllowList, ['0xold2', '0xnew1'])

        expect(permissionsManager.removeAddressesPermission).toHaveBeenCalledWith('test-world', 'deployment', [
          '0xold1'
        ])
      })

      it('should add new wallets not in the old list', async () => {
        await permissionsComponent.setDeploymentPermission('test-world', PermissionType.AllowList, ['0xold2', '0xnew1'])

        expect(permissionsManager.grantAddressesWorldWidePermission).toHaveBeenCalledWith('test-world', 'deployment', [
          '0xnew1'
        ])
      })
    })

    describe('and setting unrestricted permission', () => {
      it('should throw InvalidPermissionRequestError', async () => {
        await expect(
          permissionsComponent.setDeploymentPermission('test-world', PermissionType.Unrestricted, [])
        ).rejects.toThrow(InvalidPermissionRequestError)
      })
    })
  })

  describe('when setting streaming permissions', () => {
    describe('and setting unrestricted permission', () => {
      let existingRecords: WorldPermissionRecordForChecking[]

      beforeEach(() => {
        existingRecords = [
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'streaming',
            address: '0x1234',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ]
        permissionsManager.getWorldPermissionRecords.mockResolvedValue(existingRecords)
        permissionsManager.removeAddressesPermission.mockResolvedValue(['0x1234'])
      })

      it('should remove all streaming entries', async () => {
        await permissionsComponent.setStreamingPermission('test-world', PermissionType.Unrestricted)

        expect(permissionsManager.removeAddressesPermission).toHaveBeenCalledWith('test-world', 'streaming', ['0x1234'])
      })
    })

    describe('and setting allow-list permission', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValue([])
        permissionsManager.grantAddressesWorldWidePermission.mockResolvedValue(['0x1234'])
      })

      it('should add the wallets', async () => {
        await permissionsComponent.setStreamingPermission('test-world', PermissionType.AllowList, ['0x1234'])

        expect(permissionsManager.grantAddressesWorldWidePermission).toHaveBeenCalledWith('test-world', 'streaming', [
          '0x1234'
        ])
      })
    })

    describe('and setting an invalid permission type', () => {
      it('should throw InvalidPermissionRequestError', async () => {
        await expect(
          permissionsComponent.setStreamingPermission('test-world', 'invalid' as PermissionType)
        ).rejects.toThrow(InvalidPermissionRequestError)
      })
    })
  })

  describe('when adding parcels to a permission', () => {
    describe('and the permission is newly created', () => {
      beforeEach(() => {
        permissionsManager.addParcelsToPermission.mockResolvedValueOnce({ created: true })
      })

      it('should add parcels to the permission', async () => {
        await permissionsComponent.addParcelsToPermission('test-world', 'deployment', '0x1234', ['0,0', '1,0'])

        expect(permissionsManager.addParcelsToPermission).toHaveBeenCalledWith('test-world', 'deployment', '0x1234', [
          '0,0',
          '1,0'
        ])
      })

      it('should send a notification', async () => {
        await permissionsComponent.addParcelsToPermission('test-world', 'deployment', '0x1234', ['0,0', '1,0'])
        expect(snsClient.publishMessages).toHaveBeenCalledTimes(1)
        expect(snsClient.publishMessages).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              metadata: expect.objectContaining({ address: '0x1234' })
            })
          ])
        )
      })
    })

    describe('and the permission already exists', () => {
      beforeEach(() => {
        permissionsManager.addParcelsToPermission.mockResolvedValueOnce({ created: false })
      })

      it('should not send a notification', async () => {
        await permissionsComponent.addParcelsToPermission('test-world', 'deployment', '0x1234', ['0,0', '1,0'])
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })

  describe('when removing parcels from a permission', () => {
    describe('and the permission exists', () => {
      beforeEach(() => {
        permissionsManager.getAddressPermissions.mockResolvedValueOnce({
          id: 1,
          worldName: 'test-world',
          permissionType: 'deployment',
          address: '0x1234',
          createdAt: new Date(),
          updatedAt: new Date()
        })
        permissionsManager.removeParcelsFromPermission.mockResolvedValueOnce()
      })

      it('should remove the parcels', async () => {
        await permissionsComponent.removeParcelsFromPermission('test-world', 'deployment', '0x1234', ['0,0', '1,0'])
        expect(permissionsManager.removeParcelsFromPermission).toHaveBeenCalledWith(1, ['0,0', '1,0'])
      })
    })

    describe('and the permission does not exist', () => {
      beforeEach(() => {
        permissionsManager.getAddressPermissions.mockResolvedValueOnce(undefined)
      })

      it('should throw InvalidPermissionRequestError', async () => {
        await expect(
          permissionsComponent.removeParcelsFromPermission('test-world', 'deployment', '0x1234', ['0,0'])
        ).rejects.toThrow(InvalidPermissionRequestError)
      })
    })
  })

  describe('when getting allowed parcels for a permission', () => {
    describe('and the permission exists', () => {
      beforeEach(() => {
        permissionsManager.getAddressPermissions.mockResolvedValue({
          id: 1,
          worldName: 'test-world',
          permissionType: 'deployment',
          address: '0x1234',
          createdAt: new Date(),
          updatedAt: new Date()
        })
        permissionsManager.getParcelsForPermission.mockResolvedValue({
          total: 3,
          results: ['0,0', '1,0', '2,0']
        })
      })

      it('should return the parcels', async () => {
        const result = await permissionsComponent.getAllowedParcelsForPermission('test-world', 'deployment', '0x1234')

        expect(result).toEqual({
          total: 3,
          results: ['0,0', '1,0', '2,0']
        })
      })

      describe('and pagination and bounding box parameters are provided', () => {
        it('should pass the parameters to the manager', async () => {
          await permissionsComponent.getAllowedParcelsForPermission('test-world', 'deployment', '0x1234', 10, 5, {
            x1: 0,
            y1: 0,
            x2: 2,
            y2: 2
          })

          expect(permissionsManager.getParcelsForPermission).toHaveBeenCalledWith(1, 10, 5, {
            x1: 0,
            y1: 0,
            x2: 2,
            y2: 2
          })
        })
      })
    })

    describe('and the permission does not exist', () => {
      beforeEach(() => {
        permissionsManager.getAddressPermissions.mockResolvedValueOnce(undefined)
      })

      it('should throw PermissionNotFoundError', async () => {
        await expect(
          permissionsComponent.getAllowedParcelsForPermission('test-world', 'deployment', '0x1234')
        ).rejects.toThrow(PermissionNotFoundError)
      })
    })
  })

  describe('when getting the permissions summary', () => {
    describe('and there are permissions', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([
          {
            id: 1,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x1234',
            isWorldWide: true,
            parcelCount: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 2,
            worldName: 'test-world',
            permissionType: 'streaming',
            address: '0x1234',
            isWorldWide: false,
            parcelCount: 5,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 3,
            worldName: 'test-world',
            permissionType: 'deployment',
            address: '0x5678',
            isWorldWide: false,
            parcelCount: 3,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      })

      it('should return the summary grouped by address', async () => {
        const result = await permissionsComponent.getPermissionsSummary('test-world')

        expect(result).toEqual({
          '0x1234': [
            { permission: 'deployment', worldWide: true },
            { permission: 'streaming', worldWide: false, parcelCount: 5 }
          ],
          '0x5678': [{ permission: 'deployment', worldWide: false, parcelCount: 3 }]
        })
      })
    })

    describe('and there are no permissions', () => {
      beforeEach(() => {
        permissionsManager.getWorldPermissionRecords.mockResolvedValueOnce([])
      })

      it('should return an empty object', async () => {
        const result = await permissionsComponent.getPermissionsSummary('test-world')
        expect(result).toEqual({})
      })
    })
  })
})
