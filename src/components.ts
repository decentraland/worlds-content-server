import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent, instrumentHttpServerWithMetrics } from '@well-known-components/metrics'
import { createSubgraphComponent } from '@well-known-components/thegraph-component'
import {
  AppComponents,
  GlobalContext,
  ICommsAdapter,
  INameDenyListChecker,
  IWorldNamePermissionChecker,
  SnsComponent
} from './types'
import { metricDeclarations } from './metrics'
import { HTTPProvider } from 'eth-connect'
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent
} from '@dcl/catalyst-storage'
import { createStatusComponent } from './adapters/status'
import { createLimitsManagerComponent } from './adapters/limits-manager'
import { createWorldsManagerComponent } from './adapters/worlds-manager'
import { createCommsAdapterComponent } from './adapters/comms-adapter'
import { createWorldsIndexerComponent } from './adapters/worlds-indexer'

import { createValidator } from './logic/validations'
import { createEntityDeployer } from './adapters/entity-deployer'
import { createMigrationExecutor } from './migrations/migration-executor'
import { createNameDenyListChecker } from './adapters/name-deny-list-checker'
import { createDatabaseComponent } from './adapters/database-component'
import { createPermissionsManagerComponent } from './adapters/permissions-manager'
import { createNameOwnership } from './adapters/name-ownership'
import { createNameChecker } from './adapters/dcl-name-checker'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const logs = await createLogComponent({ config })

  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors: {} })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  await instrumentHttpServerWithMetrics({ metrics, server, config })

  const commsAdapter: ICommsAdapter = await createCommsAdapterComponent({ config, fetch, logs })

  const rpcUrl = await config.requireString('RPC_URL')
  const ethereumProvider = new HTTPProvider(rpcUrl, fetch)

  const storageFolder = (await config.getString('STORAGE_FOLDER')) || 'contents'

  const bucket = await config.getString('BUCKET')
  const fs = createFsComponent()

  const storage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ config, logs }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs, logs }, storageFolder)

  const subGraphUrl = await config.requireString('MARKETPLACE_SUBGRAPH_URL')
  const marketplaceSubGraph = await createSubgraphComponent({ config, logs, metrics, fetch }, subGraphUrl)
  const snsArn = await config.getString('SNS_ARN')

  const status = await createStatusComponent({ logs, fetch, config })

  const sns: SnsComponent = {
    arn: snsArn
  }

  const nameDenyListChecker: INameDenyListChecker = await createNameDenyListChecker({
    config,
    fetch,
    logs
  })

  const nameOwnership = await createNameOwnership({
    config,
    ethereumProvider,
    logs,
    marketplaceSubGraph
  })

  const namePermissionChecker: IWorldNamePermissionChecker = createNameChecker({
    logs,
    nameOwnership
  })

  const limitsManager = await createLimitsManagerComponent({ config, fetch, logs })

  const database = await createDatabaseComponent({ config, logs, metrics })

  const worldsManager = await createWorldsManagerComponent({ logs, database, nameDenyListChecker, storage })
  const worldsIndexer = await createWorldsIndexerComponent({ worldsManager })
  const permissionsManager = await createPermissionsManagerComponent({ worldsManager })

  const entityDeployer = createEntityDeployer({ config, logs, metrics, storage, sns, worldsManager })
  const validator = createValidator({
    config,
    nameDenyListChecker,
    namePermissionChecker,
    limitsManager,
    storage,
    worldsManager
  })

  const migrationExecutor = createMigrationExecutor({ logs, database: database, storage, worldsManager })

  return {
    commsAdapter,
    config,
    database,
    entityDeployer,
    ethereumProvider,
    fetch,
    limitsManager,
    logs,
    marketplaceSubGraph,
    metrics,
    migrationExecutor,
    nameDenyListChecker,
    nameOwnership,
    namePermissionChecker,
    permissionsManager,
    server,
    sns,
    status,
    statusChecks,
    storage,
    validator,
    worldsIndexer,
    worldsManager
  }
}
