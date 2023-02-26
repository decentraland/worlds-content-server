import { createConfigComponent } from '@well-known-components/env-config-provider'
import { Variables } from '@well-known-components/thegraph-component/dist/types'
import {
  createEndpointNameChecker,
  createNoOpNameChecker,
  createOnChainDclNameChecker,
  createTheGraphDclNameChecker
} from '../../src/adapters/world-name-permission-checker'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { getIdentity } from '../utils'
import { createHttpProviderMock } from '../mocks/http-provider-mock'
import { IWorldNamePermissionChecker } from '../../src/types'
import { IFetchComponent } from '@well-known-components/http-server'
import { Request, Response } from 'node-fetch'

describe('dcl name checker: TheGraph', function () {
  let logs: ILoggerComponent

  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
  })

  it('when permission asked for invalid name returns false', async () => {
    const permissionChecker = createTheGraphDclNameChecker({
      logs,
      marketplaceSubGraph: {
        query: async (_query: string, _variables?: Variables, _remainingAttempts?: number): Promise<any> => ({
          names: []
        })
      }
    })

    await expect(permissionChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
  })

  it('when no names returned from TheGraph returns false', async () => {
    const permissionChecker = createTheGraphDclNameChecker({
      logs,
      marketplaceSubGraph: {
        query: async (_query: string, _variables?: Variables, _remainingAttempts?: number): Promise<any> => ({
          nfts: []
        })
      }
    })

    await expect(permissionChecker.checkPermission('0xb', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  it('when requested name is returned from TheGraph returns true', async () => {
    const permissionChecker = createTheGraphDclNameChecker({
      logs,
      marketplaceSubGraph: {
        query: async (_query: string, _variables?: Variables, _remainingAttempts?: number): Promise<any> => ({
          nfts: [
            {
              name: 'my-super-name',
              owner: {
                id: '0xb'
              }
            }
          ]
        })
      }
    })

    await expect(permissionChecker.checkPermission('0xb', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  })
})

describe('dcl name checker: on-chain', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({
      NETWORK_ID: '1',
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
  })

  it.each(['', 'name'])('when permission asked for invalid name returns false', async (name) => {
    const permissionChecker = await createOnChainDclNameChecker({
      config,
      logs,
      ethereumProvider: createHttpProviderMock()
    })

    await expect(permissionChecker.checkPermission('0xb', name)).resolves.toBeFalsy()
  })

  it('when on chain validation returns false', async () => {
    const permissionChecker = await createOnChainDclNameChecker({
      config,
      logs,
      ethereumProvider: createHttpProviderMock({
        jsonrpc: '2.0',
        id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000000000000'
      })
    })

    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(permissionChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  it('when on chain validation returns true', async () => {
    const permissionChecker = await createOnChainDclNameChecker({
      config,
      logs,
      ethereumProvider: createHttpProviderMock({
        jsonrpc: '2.0',
        id: 1,
        result: '0x0000000000000000000000000000000000000000000000000000000000000001'
      })
    })

    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(permissionChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  })
})

describe('name checker: endpoint', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent
  let fetch: IFetchComponent

  beforeEach(async () => {
    config = createConfigComponent({
      LOG_LEVEL: 'DEBUG',
      ENDPOINT_NAME_CHECKER_BASE_URL: 'http://anything'
    })
    logs = await createLogComponent({ config })
    fetch = {
      fetch: async (_url: Request): Promise<Response> => new Response(undefined)
    }
  })

  it('when permission asked for invalid name returns false', async () => {
    const permissionChecker = await createEndpointNameChecker({
      config,
      fetch,
      logs
    })

    await expect(permissionChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
  })

  it('when permission asked for invalid address returns false', async () => {
    const permissionChecker = await createEndpointNameChecker({
      config,
      fetch,
      logs
    })

    await expect(permissionChecker.checkPermission('', 'anything')).resolves.toBeFalsy()
  })

  it.each([true, false])('when valid name and address it returns as per the endpoint', async (value) => {
    fetch = {
      fetch: async (_url: Request): Promise<Response> => new Response(String(value))
    }

    const permissionChecker = await createEndpointNameChecker({
      config,
      fetch,
      logs
    })

    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(permissionChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBe(value)
  })
})

describe('name checker: noop', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent
  let permissionChecker: IWorldNamePermissionChecker

  beforeEach(async () => {
    config = createConfigComponent({
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
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
