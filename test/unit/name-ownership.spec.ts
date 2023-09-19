import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createHttpProviderMock } from '../mocks/http-provider-mock'
import { createMockNameSubGraph } from '../mocks/name-subgraph-mock'
import {
  createEnsNameOwnership,
  createMarketplaceSubgraphDclNameOwnership,
  createNameOwnership,
  createOnChainDclNameOwnership
} from '../../src/adapters/name-ownership'

describe('Name Ownership', () => {
  let logs: ILoggerComponent
  beforeEach(async () => {
    logs = await createLogComponent({
      config: createConfigComponent({
        LOG_LEVEL: 'DEBUG'
      })
    })
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
          marketplaceSubGraph: createMockNameSubGraph()
        })
      ).rejects.toThrowError('Invalid nameValidatorStrategy selected: INVALID')
    })
  })

  describe('ens name ownership', function () {
    it('when ens domains are not allowed it always returns undefined', async () => {
      const config = createConfigComponent({})
      const nameOwnership = await createEnsNameOwnership({ config, ethereumProvider: createHttpProviderMock(), logs })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBeUndefined()
    })

    it('when no owner returned from the RPC call it returns 0x0', async () => {
      const config = createConfigComponent({
        ETH_NETWORK: 'mainnet',
        ALLOW_ENS_DOMAINS: 'true'
      })

      const nameOwnership = await createEnsNameOwnership({
        config,
        ethereumProvider: createHttpProviderMock([
          { jsonrpc: '2.0', id: 3, result: '0x0000000000000000000000000000000000000000000000000000000000000000' }
        ]),
        logs
      })
      await expect(nameOwnership.findOwner('my-super-name.eth')).resolves.toBe(
        '0x0000000000000000000000000000000000000000'
      )
    })

    it('when an owner is returned from the RPC call it returns it', async () => {
      const config = createConfigComponent({
        ETH_NETWORK: 'mainnet',
        ALLOW_ENS_DOMAINS: 'true'
      })
      const nameOwnership = await createEnsNameOwnership({
        config,
        ethereumProvider: createHttpProviderMock([
          { jsonrpc: '2.0', id: 2, result: '0x0000000000000000000000004cb6118ec2949ad2a06293268072659f4267a012' }
        ]),
        logs
      })
      await expect(nameOwnership.findOwner('something.eth')).resolves.toBe('0x4cb6118ec2949ad2a06293268072659f4267a012')
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
