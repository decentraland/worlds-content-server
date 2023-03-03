import { createConfigComponent } from '@well-known-components/env-config-provider'
import {
  metricDeclarations,
  metricDeclarations as theGraphMetricDeclarations
} from '@well-known-components/thegraph-component'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { getIdentity } from '../utils'
import { IFetchComponent } from '@well-known-components/http-server'
import { Request, Response } from 'node-fetch'
import {
  createDclNameChecker,
  createNoOwnershipSupportedNameChecker,
  createOnChainDclNameChecker,
  createTheGraphDclNameChecker
} from '../../src/adapters/dcl-name-checker'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { IDclNameChecker } from '../../src/types'

describe('strategy builder', function () {
  let config: IConfigComponent
  let fetch: IFetchComponent
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>

  beforeEach(async () => {
    fetch = {
      fetch: async (_url: Request): Promise<Response> =>
        new Response(
          JSON.stringify({
            data: { nfts: [] }
          })
        )
    }

    metrics = createTestMetricsComponent(theGraphMetricDeclarations)
  })

  it('it can build a TheGraph DclNameChecker', async () => {
    await expect(
      createDclNameChecker({
        config: createConfigComponent({
          LOG_LEVEL: 'DEBUG',
          NAME_VALIDATOR: 'THE_GRAPH_DCL_NAME_CHECKER',
          MARKETPLACE_SUBGRAPH_URL: 'https://subgraph.com'
        }),
        fetch,
        logs: await createLogComponent({
          config
        }),
        metrics
      })
    ).resolves.toBeDefined()
  })

  it('it can build an OnChain DclNameChecker', async () => {
    await expect(
      createDclNameChecker({
        config: createConfigComponent({
          LOG_LEVEL: 'DEBUG',
          NAME_VALIDATOR: 'ON_CHAIN_DCL_NAME_CHECKER',
          RPC_URL: 'https://rpc.com',
          NETWORK_ID: '1'
        }),
        fetch,
        logs: await createLogComponent({
          config
        }),
        metrics
      })
    ).resolves.toBeDefined()
  })

  it('it can build an OnChain DclNameChecker', async () => {
    await expect(
      createDclNameChecker({
        config: createConfigComponent({
          LOG_LEVEL: 'DEBUG',
          NAME_VALIDATOR: 'OTHER'
        }),
        fetch,
        logs: await createLogComponent({
          config
        }),
        metrics
      })
    ).resolves.toBeDefined()
  })
})

describe('dcl name checker: TheGraph', function () {
  let config: IConfigComponent
  let logs: ILoggerComponent
  let metrics: IMetricsComponent<keyof typeof metricDeclarations>

  beforeEach(async () => {
    config = createConfigComponent({
      LOG_LEVEL: 'DEBUG',
      MARKETPLACE_SUBGRAPH_URL: ''
    })
    logs = await createLogComponent({
      config
    })
    metrics = createTestMetricsComponent(theGraphMetricDeclarations)
  })

  it('when permission asked for invalid name returns false', async () => {
    const dclNameChecker = await createTheGraphDclNameChecker({
      config,
      logs,
      fetch: {
        fetch: async (_url: Request): Promise<Response> => new Response(undefined)
      },
      metrics
    })

    await expect(dclNameChecker.checkOwnership('0xb', '')).resolves.toBeFalsy()
  })

  it('when no names returned from TheGraph returns false', async () => {
    const dclNameChecker = await createTheGraphDclNameChecker({
      config,
      logs,
      fetch: {
        fetch: async (_url: Request): Promise<Response> =>
          new Response(
            JSON.stringify({
              data: { nfts: [] }
            })
          )
      },
      metrics
    })

    await expect(dclNameChecker.checkOwnership('0xb', 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  it('when requested name is returned from TheGraph returns true', async () => {
    const dclNameChecker = await createTheGraphDclNameChecker({
      config,
      logs,
      fetch: {
        fetch: async (_url: Request): Promise<Response> =>
          new Response(JSON.stringify({ data: { nfts: [{ name: 'my-super-name', owner: { id: '0xb' } }] } }))
      },
      metrics
    })
    await expect(dclNameChecker.checkOwnership('0xb', 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  })
})

describe('dcl name checker: on-chain', function () {
  let config: IConfigComponent
  let logs: ILoggerComponent

  beforeEach(async () => {
    config = createConfigComponent({
      NETWORK_ID: '1',
      LOG_LEVEL: 'DEBUG',
      RPC_URL: 'https://rpc-url.com'
    })
    logs = await createLogComponent({ config })
  })

  it.each(['', 'name'])('when permission asked for invalid name returns false', async (name) => {
    const fetch: IFetchComponent = {
      fetch: async (_url: Request): Promise<Response> => new Response(undefined)
    }

    const dclNameChecker = await createOnChainDclNameChecker({
      config,
      logs,
      fetch
    })

    await expect(dclNameChecker.checkOwnership('0xb', name)).resolves.toBeFalsy()
  })

  it('when on chain validation returns false', async () => {
    const fetch: IFetchComponent = {
      fetch: async (_url: Request): Promise<Response> =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x0000000000000000000000000000000000000000000000000000000000000000'
          })
        )
    }

    const dclNameChecker = await createOnChainDclNameChecker({
      config,
      fetch,
      logs
    })

    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(dclNameChecker.checkOwnership(address, 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })

  it('when on chain validation returns true', async () => {
    const fetch: IFetchComponent = {
      fetch: async (_url: Request): Promise<Response> =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: '0x0000000000000000000000000000000000000000000000000000000000000001'
          })
        )
    }
    const dclNameChecker = await createOnChainDclNameChecker({
      config,
      logs,
      fetch
    })

    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(dclNameChecker.checkOwnership(address, 'my-super-name.dcl.eth')).resolves.toBeTruthy()
  })
})

describe('name checker: noop', function () {
  let dclNameChecker: IDclNameChecker

  beforeEach(async () => {
    dclNameChecker = await createNoOwnershipSupportedNameChecker()
  })

  it('when permission asked for invalid name returns false', async () => {
    await expect(dclNameChecker.checkOwnership('0xb', '')).resolves.toBeFalsy()
  })

  it('when permission asked for invalid address returns false', async () => {
    await expect(dclNameChecker.checkOwnership('', 'anything')).resolves.toBeFalsy()
  })

  it('when valid name and address it returns false', async () => {
    const identity = await getIdentity()
    const address = identity.authChain.authChain[0].payload
    await expect(dclNameChecker.checkOwnership(address, 'my-super-name.dcl.eth')).resolves.toBeFalsy()
  })
})
