import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { createHttpProviderMock } from '../mocks/http-provider-mock'
import { createMockNameSubGraph } from '../mocks/name-subgraph-mock'
import {
  createEnsNameOwnership,
  createMarketplaceSubgraphDclNameOwnership,
  createNameOwnership,
  createOnChainDclNameOwnership
} from '../../src/adapters/name-ownership'
import { createFetchComponent } from '../../src/adapters/fetch'
import { IFetchComponent } from '@well-known-components/http-server'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../../src/metrics'
import { Response } from 'node-fetch'

describe('Name Ownership', () => {
  let logs: ILoggerComponent
  let fetch: IFetchComponent
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>
  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
    fetch = await createFetchComponent()
    metrics = createTestMetricsComponent(metricDeclarations)
  })

  describe('createNameOwnership', function () {
    it('creates a validator using Marketplace SubGraph', async () => {
      const nameOwnership = await createNameOwnership({
        config: createConfigComponent({
          ETH_NETWORK: 'mainnet',
          NAME_VALIDATOR: 'DCL_NAME_CHECKER'
        }),
        logs,
        ethereumProvider: createHttpProviderMock(),
        fetch,
        metrics,
        marketplaceSubGraph: createMockNameSubGraph()
      })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBeUndefined()
      await expect(nameOwnership.findOwner('my-super-name.dcl.eth')).resolves.toBeUndefined()
    })

    it('creates a validator using On Chain', async () => {
      const nameOwnership = await createNameOwnership({
        config: createConfigComponent({
          ETH_NETWORK: 'mainnet',
          NAME_VALIDATOR: 'ON_CHAIN_DCL_NAME_CHECKER'
        }),
        logs,
        ethereumProvider: createHttpProviderMock([
          { jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000005de9e77627c79ff6ec787295e4191aeeeea4acab' }
        ]),
        fetch,
        metrics,
        marketplaceSubGraph: createMockNameSubGraph()
      })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBeUndefined()
      await expect(nameOwnership.findOwner('my-super-name.dcl.eth')).resolves.toBe(
        '0x5De9e77627c79fF6ec787295E4191AEEeea4aCaB'
      )
    })

    it('fails to create a validator because of wrong config', async () => {
      await expect(
        createNameOwnership({
          config: createConfigComponent({
            ETH_NETWORK: 'mainnet',
            NAME_VALIDATOR: 'INVALID'
          }),
          logs,
          ethereumProvider: createHttpProviderMock(),
          fetch,
          metrics,
          marketplaceSubGraph: createMockNameSubGraph()
        })
      ).rejects.toThrowError('Invalid nameValidatorStrategy selected: INVALID')
    })
  })

  describe('ens name ownership', function () {
    let fetch: any
    beforeEach(async () => {
      fetch = createFetchComponent()
      fetch = {
        fetch: jest.fn()
      }
    })

    it('when no ens subgraph url provided it always returns undefined', async () => {
      const config = createConfigComponent({})
      const nameOwnership = await createEnsNameOwnership({ config, logs, fetch, metrics })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBeUndefined()
      expect(fetch.fetch).not.toHaveBeenCalled()
    })

    it('when no owner returned from TheGraph returns undefined', async () => {
      const config = createConfigComponent({
        ENS_SUBGRAPH_URL: 'http://localhost'
      })
      fetch.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              nfts: []
            }
          })
        )
      )

      const nameOwnership = await createEnsNameOwnership({ config, logs, fetch, metrics })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBeUndefined()
    })

    it('when an owner is returned from the subgraph it returns it', async () => {
      const config = createConfigComponent({
        ENS_SUBGRAPH_URL: 'http://localhost'
      })
      fetch.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              nfts: [
                {
                  name: 'something.eth',
                  owner: {
                    id: '0x1'
                  }
                }
              ]
            }
          })
        )
      )
      const nameOwnership = await createEnsNameOwnership({
        config,
        logs,
        fetch,
        metrics
      })
      await expect(nameOwnership.findOwner('something.eth')).resolves.toBe('0x1')
    })
  })

  describe('DCL name ownership (Marketplace Subgraph)', function () {
    it('when no owner returned from TheGraph returns undefined', async () => {
      const nameOwnership = await createMarketplaceSubgraphDclNameOwnership({
        logs,
        marketplaceSubGraph: createMockNameSubGraph()
      })
      await expect(nameOwnership.findOwner('my-super-name.dcl.eth')).resolves.toBeUndefined()
    })

    it('when an owner is returned from the subgraph it returns it', async () => {
      const nameOwnership = await createMarketplaceSubgraphDclNameOwnership({
        logs,
        marketplaceSubGraph: createMockNameSubGraph({ nfts: [{ name: 'something', owner: { id: '0x1' } }] })
      })
      await expect(nameOwnership.findOwner('something.dcl.eth')).resolves.toBe('0x1')
    })
  })

  describe('DCL name ownership (On Chain)', function () {
    let config: IConfigComponent
    beforeEach(async () => {
      config = createConfigComponent({
        ETH_NETWORK: 'mainnet'
      })
    })

    it('can not create the component with wrong configuration', async () => {
      await expect(
        createOnChainDclNameOwnership({
          config: createConfigComponent({
            ETH_NETWORK: 'invalid'
          }),
          logs,
          ethereumProvider: createHttpProviderMock()
        })
      ).rejects.toThrowError()
    })

    it('when no owner returned from call returns undefined', async () => {
      const nameOwnership = await createOnChainDclNameOwnership({
        config,
        logs,
        ethereumProvider: createHttpProviderMock([
          {
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001f54686520737562646f6d61696e206973206e6f74207265676973746572656400',
              message: 'execution reverted: The subdomain is not registered'
            }
          }
        ])
      })
      await expect(nameOwnership.findOwner('my-super-name.dcl.eth')).resolves.toBeUndefined()
    })

    it('when an owner is returned from call it returns it', async () => {
      const nameOwnership = await createOnChainDclNameOwnership({
        config,
        logs,
        ethereumProvider: createHttpProviderMock([
          { jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000005de9e77627c79ff6ec787295e4191aeeeea4acab' }
        ])
      })
      await expect(nameOwnership.findOwner('mariano.dcl.eth')).resolves.toBe(
        '0x5De9e77627c79fF6ec787295E4191AEEeea4aCaB'
      )
    })
  })
})
