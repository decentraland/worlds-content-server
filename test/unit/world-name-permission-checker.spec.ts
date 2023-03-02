import { createConfigComponent } from '@well-known-components/env-config-provider'
import {
  createDclNamePlusACLPermissionChecker,
  createEndpointNameChecker,
  createNoOpNameChecker
} from '../../src/adapters/world-name-permission-checker'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createDeployment, getIdentity, storeJson } from '../utils'
import { IWorldNamePermissionChecker, IWorldsManager } from '../../src/types'
import { IFetchComponent } from '@well-known-components/http-server'
import { Request, Response } from 'node-fetch'
import { EntityType, EthAddress } from '@dcl/schemas'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { IContentStorageComponent } from '@dcl/catalyst-storage/dist/types'
import { Authenticator } from '@dcl/crypto'

describe('dcl name checker + ACL', function () {
  let logs: ILoggerComponent
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager
  let identity

  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerComponent({ logs, storage })
    identity = await getIdentity()
  })

  describe('checkPermission', () => {
    it('when dcl name checker says yes, returns true', async () => {
      const permissionChecker = await createDclNamePlusACLPermissionChecker({
        logs,
        worldsManager,
        dclNameChecker: {
          checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
            return Promise.resolve(true)
          }
        }
      })

      await expect(permissionChecker.checkPermission('0xa', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
    })

    it('when dcl name checker says no and no ACL configured returns false', async () => {
      const permissionChecker = await createDclNamePlusACLPermissionChecker({
        logs,
        worldsManager,
        dclNameChecker: {
          checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
            return Promise.resolve(false)
          }
        }
      })

      await expect(permissionChecker.checkPermission('0xa', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
    })

    it('when dcl name checker says no and ACL configured it honors ACL', async () => {
      const delegatedIdentity = await getIdentity()

      const payload = `{"resource":"my-world.dcl.eth","allowed":["${delegatedIdentity.realAccount.address}"]}`

      await storeJson(storage, 'name-my-world.dcl.eth', {
        entityId: 'bafkreiax5plaxze77tnjbnozga7dsbefdh53horza4adf2xjzxo3k5i4xq',
        acl: Authenticator.signPayload(identity.authChain, payload)
      })

      const permissionChecker = await createDclNamePlusACLPermissionChecker({
        logs,
        worldsManager,
        dclNameChecker: {
          checkOwnership(ethAddress: EthAddress, _worldName: string): Promise<boolean> {
            return Promise.resolve(identity.realAccount.address.toLowerCase() === ethAddress.toLowerCase())
          }
        }
      })

      // Rejects address not included in ACL
      await expect(permissionChecker.checkPermission('0xa', 'my-world.dcl.eth')).resolves.toBeFalsy()

      // Accepts address included in ACL
      await expect(
        permissionChecker.checkPermission(delegatedIdentity.authChain.authChain[0].payload, 'my-world.dcl.eth')
      ).resolves.toBeTruthy()
    })
  })

  describe('validate', () => {
    it.each([false, true])('returns same value as checkPermission', async (expected) => {
      const permissionChecker = await createDclNamePlusACLPermissionChecker({
        logs,
        worldsManager,
        dclNameChecker: {
          checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
            return Promise.resolve(expected)
          }
        }
      })

      const deployment = await createDeployment(identity.authChain)
      await expect(permissionChecker.validate(deployment)).resolves.toBe(
        await permissionChecker.checkPermission(identity.realAccount.address, 'my-world.dcl.eth')
      )
    })
  })
})

// describe('name checker: endpoint', function () {
//   let logs: ILoggerComponent
//   let config: IConfigComponent
//   let fetch: IFetchComponent
//
//   beforeEach(async () => {
//     config = createConfigComponent({
//       LOG_LEVEL: 'DEBUG',
//       ENDPOINT_NAME_CHECKER_BASE_URL: 'http://anything'
//     })
//     logs = await createLogComponent({ config })
//     fetch = {
//       fetch: async (_url: Request): Promise<Response> => new Response(undefined)
//     }
//   })
//
//   it('when permission asked for invalid name returns false', async () => {
//     const permissionChecker = await createEndpointNameChecker({
//       config,
//       fetch,
//       logs
//     })
//
//     await expect(permissionChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
//   })
//
//   it('when permission asked for invalid address returns false', async () => {
//     const permissionChecker = await createEndpointNameChecker({
//       config,
//       fetch,
//       logs
//     })
//
//     await expect(permissionChecker.checkPermission('', 'anything')).resolves.toBeFalsy()
//   })
//
//   it.each([true, false])('when valid name and address it returns as per the endpoint', async (value) => {
//     fetch = {
//       fetch: async (_url: Request): Promise<Response> => new Response(String(value))
//     }
//
//     const permissionChecker = await createEndpointNameChecker({
//       config,
//       fetch,
//       logs
//     })
//
//     const identity = await getIdentity()
//     const address = identity.authChain.authChain[0].payload
//     await expect(permissionChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBe(value)
//   })
// })

describe('name checker: noop', () => {
  let permissionChecker: IWorldNamePermissionChecker
  let identity

  beforeEach(async () => {
    permissionChecker = await createNoOpNameChecker()
    identity = await getIdentity()
  })

  describe('checkPermission', () => {
    it('when permission asked for invalid name returns false', async () => {
      await expect(permissionChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
    })

    it('when permission asked for invalid address returns false', async () => {
      await expect(permissionChecker.checkPermission('', 'anything')).resolves.toBeFalsy()
    })

    it('when valid name and address it returns true', async () => {
      const identity = await getIdentity()
      const address = identity.authChain.authChain[0].payload
      await expect(permissionChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBeTruthy()
    })
  })

  describe('validate', () => {
    it('when permission asked for invalid name returns false', async () => {
      const deployment = await createDeployment(identity.authChain, {
        type: EntityType.SCENE,
        pointers: ['0,0'],
        timestamp: Date.parse('2022-11-01T00:00:00Z'),
        metadata: { worldConfiguration: { name: '' } },
        files: []
      })

      await expect(permissionChecker.validate(deployment)).resolves.toBeTruthy()
    })

    it('when valid name and address it returns true', async () => {
      const deployment = await createDeployment(identity.authChain)
      await expect(permissionChecker.validate(deployment)).resolves.toBeTruthy()
    })
  })
})
