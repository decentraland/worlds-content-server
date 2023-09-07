import { createPermissionChecker, defaultPermissions } from '../../src/logic/permissions-checker'
import { AccessPermissionSetting, PermissionType } from '../../src/types'
import bcrypt from 'bcrypt'

describe('Permissions Checker', function () {
  it('Unknown permission type', async () => {
    expect(() =>
      createPermissionChecker({
        ...defaultPermissions(),
        access: {
          type: 'unknown' as PermissionType,
          wallets: ['0x1234']
        } as AccessPermissionSetting
      })
    ).toThrowError('Invalid permission type.')
  })

  it('UnrestrictedPermissionChecker', async () => {
    const permissionChecker = createPermissionChecker({
      ...defaultPermissions()
    })

    expect(await permissionChecker.checkPermission('access', '0x1234')).toBeTruthy()
  })

  it('SharedSecretChecker', async () => {
    const permissionChecker = createPermissionChecker({
      ...defaultPermissions(),
      access: {
        type: PermissionType.SharedSecret,
        secret: bcrypt.hashSync('some-secret', 10)
      }
    })

    expect(await permissionChecker.checkPermission('access', '0x1234', '')).toBeFalsy()
    expect(await permissionChecker.checkPermission('access', '0x1234', 'some-secret')).toBeTruthy()
    expect(await permissionChecker.checkPermission('access', '0x1234', 'wrong-secret')).toBeFalsy()
  })

  it('NftOwnershipChecker', async () => {
    const permissionChecker = createPermissionChecker({
      ...defaultPermissions(),
      access: {
        type: PermissionType.NFTOwnership,
        nft: 'some-nft'
      }
    })

    expect(await permissionChecker.checkPermission('access', '0x1234')).toBeFalsy()
  })

  it('AllowListChecker', async () => {
    const permissionChecker = createPermissionChecker({
      ...defaultPermissions(),
      access: {
        type: PermissionType.AllowList,
        wallets: ['0x1234']
      }
    })

    expect(await permissionChecker.checkPermission('access', '0x1234')).toBeTruthy()
    expect(await permissionChecker.checkPermission('access', '0x5678')).toBeFalsy()
  })
})
