import { createConfigComponent } from '@well-known-components/env-config-provider'
import {
  createDclNamePlusACLPermissionChecker,
  createEndpointNameChecker,
  createNoOpNameChecker
} from '../../src/adapters/world-name-permission-checker'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { getIdentity } from '../utils'
import { IWorldNamePermissionChecker, IWorldsManager } from '../../src/types'
import { IFetchComponent } from '@well-known-components/http-server'
import { Request, Response } from 'node-fetch'
import { EthAddress } from '@dcl/schemas'
import { createWorldsManagerComponent } from '../../src/adapters/worlds-manager'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { IContentStorageComponent } from '@dcl/catalyst-storage/dist/types'

describe('dcl name checker + ACL', function () {
  let logs: ILoggerComponent
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager

  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerComponent({ logs, storage })
  })

  it('when dcl name checker says no returns false', async () => {
    const permissionChecker = await createDclNamePlusACLPermissionChecker({
      logs,
      worldsManager,
      dclNameChecker: {
        checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
          return Promise.resolve(false)
        }
      }
    })

    await expect(permissionChecker.validate('0xb', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  // it('when requested name is returned from TheGraph returns true', async () => {
  //   const permissionChecker = await createDclNamePlusACLPermissionChecker({
  //     logs,
  //     dclNameChecker: {
  //       checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
  //         return Promise.resolve(true)
  //       }
  //     }
  //   })
  //   await expect(permissionChecker.checkPermission('0xb', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  // })
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

describe('name checker: noop', function () {
  let permissionChecker: IWorldNamePermissionChecker

  beforeEach(async () => {
    permissionChecker = await createNoOpNameChecker()
  })

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
