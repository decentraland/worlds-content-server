import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createDclNameChecker, createOnChainDclNameChecker } from '../../src/adapters/dcl-name-checker'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { getIdentity } from '../utils'
import { createHttpProviderMock } from '../mocks/http-provider-mock'
import { createMockNameSubGraph } from '../mocks/name-subgraph-mock'

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
    const dclNameChecker = createDclNameChecker({
      logs,
      ensSubGraph: createMockNameSubGraph(),
      marketplaceSubGraph: createMockNameSubGraph()
    })

    await expect(dclNameChecker.checkPermission('0xb', '')).resolves.toBeFalsy()
  })

  describe('for dcl names', () => {
    it('when no names returned from TheGraph returns false', async () => {
      const dclNameChecker = createDclNameChecker({
        logs,
        ensSubGraph: createMockNameSubGraph(),
        marketplaceSubGraph: createMockNameSubGraph()
      })

      await expect(dclNameChecker.checkPermission('0xb', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
    })

    it('when requested name is returned from TheGraph returns true', async () => {
      const dclNameChecker = createDclNameChecker({
        logs,
        ensSubGraph: createMockNameSubGraph(),
        marketplaceSubGraph: createMockNameSubGraph({
          nfts: [
            {
              name: 'my-super-name',
              owner: {
                id: '0xb'
              }
            }
          ]
        })
      })

      await expect(dclNameChecker.checkPermission('0xb', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
    })
  })

  describe('for ens names', () => {
    it('when no names returned from TheGraph returns false', async () => {
      const dclNameChecker = createDclNameChecker({
        logs,
        ensSubGraph: createMockNameSubGraph(),
        marketplaceSubGraph: createMockNameSubGraph()
      })

      await expect(dclNameChecker.checkPermission('0xb', 'my-super-name.eth')).resolves.toBeFalsy()
    })

    it('when requested name is returned from TheGraph returns true', async () => {
      const dclNameChecker = createDclNameChecker({
        logs,
        ensSubGraph: createMockNameSubGraph({
          nfts: [
            {
              name: 'my-super-name.eth',
              owner: {
                id: '0xb'
              }
            }
          ]
        }),
        marketplaceSubGraph: createMockNameSubGraph()
      })

      await expect(dclNameChecker.checkPermission('0xb', 'my-super-name.eth')).resolves.toBeTruthy()
    })
  })
})

describe('dcl name checker: on-chain', function () {
  let logs: ILoggerComponent
  let config: IConfigComponent

  beforeEach(async () => {
    config = createConfigComponent({
      ETH_NETWORK: 'mainnet',
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
  })

  it.each(['', 'name'])('when permission asked for invalid name returns false', async (name) => {
    const dclNameChecker = await createOnChainDclNameChecker({
      config,
      ensSubGraph: createMockNameSubGraph(),
      logs,
      ethereumProvider: createHttpProviderMock()
    })

    await expect(dclNameChecker.checkPermission('0xb', name)).resolves.toBeFalsy()
  })

  it('fails to create when wrong network', async () => {
    await expect(
      createOnChainDclNameChecker({
        config: (config = createConfigComponent({
          ETH_NETWORK: 'invalid'
        })),
        ensSubGraph: createMockNameSubGraph(),
        logs,
        ethereumProvider: createHttpProviderMock([])
      })
    ).rejects.toThrowError('Invalid ETH_NETWORK: invalid')
  })

  describe('for dcl names', () => {
    it('when on chain validation returns false', async () => {
      const dclNameChecker = await createOnChainDclNameChecker({
        config,
        ensSubGraph: createMockNameSubGraph(),
        logs,
        ethereumProvider: createHttpProviderMock([
          {
            jsonrpc: '2.0',
            id: 1,
            result: '0x0000000000000000000000000000000000000000000000000000000000000000'
          }
        ])
      })

      const identity = await getIdentity()
      const address = identity.authChain.authChain[0].payload
      await expect(dclNameChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBeFalsy()
    })

    it('when on chain validation returns true', async () => {
      const dclNameChecker = await createOnChainDclNameChecker({
        config,
        ensSubGraph: createMockNameSubGraph(),
        logs,
        ethereumProvider: createHttpProviderMock([
          {
            jsonrpc: '2.0',
            id: 1,
            result: '0x0000000000000000000000000000000000000000000000000000000000000001'
          }
        ])
      })

      const identity = await getIdentity()
      const address = identity.authChain.authChain[0].payload
      await expect(dclNameChecker.checkPermission(address, 'my-super-name.dcl.eth')).resolves.toBeTruthy()
    })
  })

  describe('for ens names', () => {
    it('when on chain validation returns false', async () => {
      const dclNameChecker = await createOnChainDclNameChecker({
        config,
        ensSubGraph: createMockNameSubGraph(),
        logs,
        ethereumProvider: createHttpProviderMock()
      })

      const identity = await getIdentity()
      const address = identity.authChain.authChain[0].payload
      await expect(dclNameChecker.checkPermission(address, 'my-super-name.eth')).resolves.toBeFalsy()
    })

    it('when on chain validation returns true', async () => {
      const identity = await getIdentity()
      const address = identity.realAccount.address

      const dclNameChecker = await createOnChainDclNameChecker({
        config,
        ensSubGraph: createMockNameSubGraph({
          nfts: [
            {
              name: 'my-super-name.eth',
              owner: {
                id: address
              }
            }
          ]
        }),
        logs,
        ethereumProvider: createHttpProviderMock()
      })

      await expect(dclNameChecker.checkPermission(address, 'my-super-name.eth')).resolves.toBeTruthy()
    })
  })
})
