// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment

import { createLocalFetchCompoment, createRunner } from '@well-known-components/test-helpers'

import { main } from '../src/service'
import { SnsClient, TestComponents } from '../src/types'
import { initComponents as originalInitComponents } from '../src/components'
import { createMockNameSubGraph } from './mocks/name-subgraph-mock'
import { createMockNamePermissionChecker } from './mocks/dcl-name-checker-mock'
import { createMockLimitsManagerComponent } from './mocks/limits-manager-mock'
import { createMockStatusComponent } from './mocks/status-mock'
import { createInMemoryStorage } from '@dcl/catalyst-storage'
import { createMockCommsAdapterComponent } from './mocks/comms-adapter-mock'
import { createWorldsIndexerComponent } from '../src/adapters/worlds-indexer'
import * as nodeFetch from 'node-fetch'

import { createValidator } from '../src/logic/validations'
import { createTestMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations } from '../src/metrics'
import { createEntityDeployer } from '../src/adapters/entity-deployer'
import { createMockNameDenyListChecker } from './mocks/name-deny-list-checker-mock'
import { createWorldCreator } from './mocks/world-creator'
import { createWorldsManagerComponent } from '../src/adapters/worlds-manager'
import { createPermissionsManagerComponent } from '../src/adapters/permissions-manager'
import { createMockNameOwnership } from './mocks/name-ownership-mock'
import { createMockUpdateOwnerJob } from './mocks/update-owner-job-mock'
import { createSnsClientMock } from './mocks/sns-client-mock'
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'

/**
 * Behaves like Jest "describe" function, used to describe a test for a
 * use case; it creates a whole new program and components to run an
 * isolated test.
 *
 * State is persistent within the steps of the test.
 */
export const test = createRunner<TestComponents>({
  main,
  initComponents
})

async function initComponents(): Promise<TestComponents> {
  const components = await originalInitComponents()

  const { logs, database } = components
  const config = await createDotEnvConfigComponent(
    { path: ['.env.default', '.env'] },
    {
      SNS_ARN: 'some-arn'
    }
  )

  const metrics = createTestMetricsComponent(metricDeclarations)

  const storage = createInMemoryStorage()

  const nameDenyListChecker = createMockNameDenyListChecker()

  const namePermissionChecker = createMockNamePermissionChecker()

  const fetch = {
    async fetch(url: nodeFetch.RequestInfo, init?: nodeFetch.RequestInit): Promise<nodeFetch.Response> {
      return nodeFetch.default(url, init).then(async (response: nodeFetch.Response) => {
        if (response.ok) {
          // response.status >= 200 && response.status < 300
          return response
        }

        throw new Error(await response.text())
      })
    }
  }

  const limitsManager = createMockLimitsManagerComponent()

  const commsAdapter = createMockCommsAdapterComponent()

  const nameOwnership = createMockNameOwnership()

  const worldsManager = await createWorldsManagerComponent({
    logs,
    database,
    nameDenyListChecker,
    storage
  })

  const worldsIndexer = await createWorldsIndexerComponent({ worldsManager })

  const permissionsManager = await createPermissionsManagerComponent({ worldsManager })

  const snsClient: SnsClient = createSnsClientMock()

  const entityDeployer = createEntityDeployer({
    config,
    logs,
    nameOwnership,
    metrics,
    storage,
    snsClient,
    worldsManager
  })

  const validator = createValidator({
    config,
    limitsManager,
    nameDenyListChecker,
    namePermissionChecker,
    storage,
    worldsManager
  })
  const status = createMockStatusComponent()

  const updateOwnerJob = await createMockUpdateOwnerJob({})

  const worldCreator = createWorldCreator({ storage, worldsManager })

  return {
    ...components,
    commsAdapter,
    entityDeployer,
    fetch,
    limitsManager,
    localFetch: await createLocalFetchCompoment(config),
    marketplaceSubGraph: createMockNameSubGraph(),
    metrics,
    namePermissionChecker,
    permissionsManager,
    snsClient,
    status,
    storage,
    updateOwnerJob,
    validator,
    worldCreator,
    worldsIndexer,
    worldsManager
  }
}
