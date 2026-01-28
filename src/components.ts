import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from '@dcl/platform-server-commons'
import { createMetricsComponent } from '@well-known-components/metrics'
import { createSubgraphComponent } from '@well-known-components/thegraph-component'
import { AppComponents, GlobalContext, ICommsAdapter, INameDenyListChecker, IWorldNamePermissionChecker } from './types'
import { metricDeclarations } from './metrics'
import { HTTPProvider } from 'eth-connect'
import {
  createFolderBasedFileSystemContentStorage,
  createFsComponent,
  createS3BasedFileSystemContentStorage
} from '@dcl/catalyst-storage'
import { createStatusComponent } from './adapters/status'
import { createLimitsManagerComponent } from './adapters/limits-manager'
import { createWorldsManagerComponent } from './adapters/worlds-manager'
import { createCommsAdapterComponent } from './adapters/comms-adapter'
import { createWorldsIndexerComponent } from './adapters/worlds-indexer'

import { createValidator } from './logic/validations'
import { createEntityDeployer } from './adapters/entity-deployer'
import { createMigrationExecutor } from './adapters/migration-executor'
import { createNameDenyListChecker } from './adapters/name-deny-list-checker'
import { createDatabaseComponent } from './adapters/database-component'
import { createPermissionsManagerComponent } from './adapters/permissions-manager'
import { createNameOwnership } from './adapters/name-ownership'
import { createNameChecker } from './adapters/dcl-name-checker'
import { createWalletStatsComponent } from './adapters/wallet-stats'
import { createUpdateOwnerJob } from './adapters/update-owner-job'
import { createSnsComponent } from '@dcl/sns-component'
import { createAwsConfig } from './adapters/aws-config'
import { S3 } from 'aws-sdk'
import { createNotificationsClientComponent } from './adapters/notifications-service'
import { createNatsComponent } from '@well-known-components/nats-component'
import { createSchemaValidatorComponent } from '@dcl/schema-validator-component'
import { createLivekitClient } from './adapters/livekit-client'
import { createPeersRegistry } from './adapters/peers-registry'
import { createSettingsComponent } from './logic/settings'
import { createCoordinatesComponent } from './logic/coordinates'
import { createPermissionsComponent } from './logic/permissions'
import { createAccessComponent } from './logic/access'
import { createSearchComponent } from './adapters/search'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const awsConfig = await createAwsConfig({ config })
  const logs = await createLogComponent({ config })

  const logger = logs.getLogger('components')
  const commitHash = (await config.getString('COMMIT_HASH')) || 'unknown'
  logger.info(`Initializing components. Version: ${commitHash}`)

  const server = await createServerComponent<GlobalContext>(
    { config, logs },
    {
      cors: {
        methods: ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'POST', 'PUT'],
        maxAge: 86400
      }
    }
  )
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  await instrumentHttpServerWithPromClientRegistry({ metrics, server, config, registry: metrics.registry! })

  const nats = await createNatsComponent({ config, logs })

  const commsAdapter: ICommsAdapter = await createCommsAdapterComponent({ config, fetch, logs })

  const rpcUrl = await config.requireString('RPC_URL')
  const ethereumProvider = new HTTPProvider(rpcUrl, fetch)

  const storageFolder = (await config.getString('STORAGE_FOLDER')) || 'contents'

  const bucket = await config.getString('BUCKET')
  const fs = createFsComponent()

  const storage = bucket
    ? await createS3BasedFileSystemContentStorage({ logs }, new S3(awsConfig), {
        Bucket: bucket
      })
    : await createFolderBasedFileSystemContentStorage({ fs, logs }, storageFolder)

  const subGraphUrl = await config.requireString('MARKETPLACE_SUBGRAPH_URL')
  const marketplaceSubGraph = await createSubgraphComponent({ config, logs, metrics, fetch }, subGraphUrl)

  const status = await createStatusComponent({ logs, fetch, config })
  const snsClient = await createSnsComponent({ config })

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

  const database = await createDatabaseComponent({ config, logs, metrics })

  const coordinates = createCoordinatesComponent()

  const search = await createSearchComponent({ database, logs })

  const worldsManager = await createWorldsManagerComponent({
    coordinates,
    logs,
    database,
    nameDenyListChecker,
    search,
    storage
  })

  const walletStats = await createWalletStatsComponent({ config, database, fetch, logs, worldsManager })

  const limitsManager = await createLimitsManagerComponent({ config, fetch, logs, nameOwnership, walletStats })
  const worldsIndexer = await createWorldsIndexerComponent({ worldsManager })
  const permissionsManager = await createPermissionsManagerComponent({ database, worldsManager })
  const permissions = await createPermissionsComponent({ config, permissionsManager, snsClient })
  const access = createAccessComponent({ worldsManager })

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
    nameDenyListChecker,
    namePermissionChecker,
    limitsManager,
    permissions,
    storage,
    worldsManager
  })

  const migrationExecutor = createMigrationExecutor({ logs, database: database, nameOwnership, storage, worldsManager })

  const notificationService = await createNotificationsClientComponent({ config, fetch, logs })

  const updateOwnerJob = await createUpdateOwnerJob({
    config,
    database,
    fetch,
    logs,
    nameOwnership,
    snsClient,
    walletStats
  })

  const peersRegistry = await createPeersRegistry({ config })
  const livekitClient = await createLivekitClient({ config })
  const settings = await createSettingsComponent({
    config,
    coordinates,
    namePermissionChecker,
    storage,
    snsClient,
    worldsManager
  })
  const schemaValidator = createSchemaValidatorComponent()

  return {
    access,
    awsConfig,
    schemaValidator,
    settings,
    commsAdapter,
    config,
    coordinates,
    database,
    entityDeployer,
    ethereumProvider,
    fetch,
    limitsManager,
    livekitClient,
    logs,
    marketplaceSubGraph,
    metrics,
    migrationExecutor,
    nats,
    nameDenyListChecker,
    nameOwnership,
    namePermissionChecker,
    notificationService,
    permissions,
    permissionsManager,
    peersRegistry,
    search,
    server,
    snsClient,
    status,
    statusChecks,
    storage,
    updateOwnerJob,
    validator,
    walletStats,
    worldsIndexer,
    worldsManager
  }
}
