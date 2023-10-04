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
      const map = await nameOwnership.findOwners(['my-super-name.eth', 'my-super-name.dcl.eth'])
      expect(map.get('my-super-name.eth')).toBeUndefined()
      expect(map.get('my-super-name.dcl.eth')).toBeUndefined()
    })

    it('creates a validator using On Chain', async () => {
      const nameOwnership = await createNameOwnership({
        config: createConfigComponent({
          ETH_NETWORK: 'mainnet',
          NAME_VALIDATOR: 'ON_CHAIN_DCL_NAME_CHECKER'
        }),
        logs,
        ethereumProvider: createHttpProviderMock([
          [
            { jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000005de9e77627c79ff6ec787295e4191aeeeea4acab' },
            { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'execution reverted' } }
          ]
        ]),
        marketplaceSubGraph: createMockNameSubGraph()
      })
      const map = await nameOwnership.findOwners(['my-super-name.eth', 'my-super-name.dcl.eth'])
      expect(map.get('my-super-name.eth')).toBeUndefined()
      expect(map.get('my-super-name.dcl.eth')).toBe('0x5de9e77627c79ff6ec787295e4191aeeeea4acab')
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
      const config = createConfigComponent({
        ETH_NETWORK: 'mainnet',
        ALLOW_ENS_DOMAINS: 'false'
      })
      const nameOwnership = await createEnsNameOwnership({ config, ethereumProvider: createHttpProviderMock(), logs })
      const map = await nameOwnership.findOwners(['my-super-name.eth'])
      expect(map.get('my-super-name.eth')).toBeUndefined()
    })

    it('when ens domains are allowed but wrong network it fails to create object', async () => {
      const config = createConfigComponent({
        ETH_NETWORK: 'invalid',
        ALLOW_ENS_DOMAINS: 'true'
      })
      await expect(
        createEnsNameOwnership({ config, ethereumProvider: createHttpProviderMock(), logs })
      ).rejects.toThrowError('Invalid ETH_NETWORK: invalid')
    })

    describe('Unwrapped name', function () {
      it('when ens name does not exist or has already expired it returns undefined', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })

        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } }]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['my-super-name.eth'])
        expect(map.get('my-super-name.eth')).toBeUndefined()
      })

      it('when an owner is returned from the RPC call it returns it', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })
        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [{ jsonrpc: '2.0', id: 2, result: '0x0000000000000000000000004cb6118ec2949ad2a06293268072659f4267a012' }]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['something.eth'])
        expect(map.get('something.eth')).toBe('0x4cb6118ec2949ad2a06293268072659f4267a012')
      })
    })

    describe('Wrapped name', function () {
      it('when ens name does not exist or has already expired it returns undefined', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })

        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } }]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['my-super-name.eth'])
        expect(map.get('my-super-name.eth')).toBeUndefined()
      })

      it('when the owner is NameWrapper we ask that contract and return the response', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })
        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [
              { jsonrpc: '2.0', id: 1, result: '0x000000000000000000000000d76a10326397f3d07fa0d1fa5296933ec2747f18' },
              { jsonrpc: '2.0', id: 2, result: '0x000000000000000000000000D4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401' }
            ]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['something.eth'])
        expect(map.get('something.eth')).toBe('0xd76a10326397f3d07fa0d1fa5296933ec2747f18')
      })

      it('attempts to resolve non registered 3-level domain and returns the response', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })
        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [{ jsonrpc: '2.0', id: 2, result: '0x0000000000000000000000000000000000000000000000000000000000000000' }]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['level3.something.eth'])
        expect(map.get('level3.something.eth')).toBeUndefined()
      })

      it('attempts to resolve a registered 3-level domain and returns the response', async () => {
        const config = createConfigComponent({
          ETH_NETWORK: 'mainnet',
          ALLOW_ENS_DOMAINS: 'true'
        })
        const nameOwnership = await createEnsNameOwnership({
          config,
          ethereumProvider: createHttpProviderMock([
            [{ jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000002ecfd3d4d9d53fa91904641b09cba7e09e66a121' }]
          ]),
          logs
        })
        const map = await nameOwnership.findOwners(['level3.something.eth'])
        expect(map.get('level3.something.eth')).toBe('0x2ecfd3d4d9d53fa91904641b09cba7e09e66a121')
      })
    })
  })

  describe('DCL name ownership (Marketplace Subgraph)', function () {
    it('when no owner returned from TheGraph returns undefined', async () => {
      const nameOwnership = await createMarketplaceSubgraphDclNameOwnership({
        logs,
        marketplaceSubGraph: createMockNameSubGraph()
      })
      const map = await nameOwnership.findOwners(['my-super-name.dcl.eth'])
      expect(map.get('my-super-name.dcl.eth')).toBeUndefined()
    })

    it('when an owner is returned from the subgraph it returns it', async () => {
      const nameOwnership = await createMarketplaceSubgraphDclNameOwnership({
        logs,
        marketplaceSubGraph: createMockNameSubGraph({
          Psomething: [{ name: 'something', owner: { id: '0x1' } }]
        })
      })
      const map = await nameOwnership.findOwners(['something.dcl.eth'])
      expect(map.get('something.dcl.eth')).toBe('0x1')
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
          [
            {
              jsonrpc: '2.0',
              id: 1,
              error: {
                code: 3,
                data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001f54686520737562646f6d61696e206973206e6f74207265676973746572656400',
                message: 'execution reverted: The subdomain is not registered'
              }
            }
          ]
        ])
      })
      const map = await nameOwnership.findOwners(['my-super-name.dcl.eth'])
      expect(map.get('my-super-name.dcl.eth')).toBeUndefined()
    })

    it('when an owner is returned from call it returns it', async () => {
      const nameOwnership = await createOnChainDclNameOwnership({
        config,
        logs,
        ethereumProvider: createHttpProviderMock([
          [{ jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000005de9e77627c79ff6ec787295e4191aeeeea4acab' }]
        ])
      })
      const map = await nameOwnership.findOwners(['my-super-name.dcl.eth'])
      expect(map.get('my-super-name.dcl.eth')).toBe('0x5de9e77627c79ff6ec787295e4191aeeeea4acab')
    })
  })
})
