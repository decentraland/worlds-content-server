import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createFetchComponent } from './adapters/fetch'
import { createMetricsComponent } from '@well-known-components/metrics'
import { metricDeclarations as theGraphMetricDeclarations } from '@well-known-components/thegraph-component'
import { AppComponents, GlobalContext, ICommsAdapter, SnsComponent } from './types'
import { metricDeclarations } from './metrics'
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent
} from '@dcl/catalyst-storage'
import { createStatusComponent } from './adapters/status'
import { createValidator } from './adapters/validator'
import { createWorldNamePermissionChecker } from './adapters/world-name-permission-checker'
import { createLimitsManagerComponent } from './adapters/limits-manager'
import { createWorldsManagerComponent } from './adapters/worlds-manager'
import { createCommsAdapterComponent } from './adapters/comms-adapter'
import { createDclNameChecker } from './adapters/dcl-name-checker'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const logs = await createLogComponent({ config })

  const logger = logs.getLogger('components')
  const secret = await config.getString('AUTH_SECRET')
  if (!secret) {
    logger.warn('No secret defined, deployed worlds will not be returned.')
  }

  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors: {} })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const metrics = await createMetricsComponent(
    { ...metricDeclarations, ...theGraphMetricDeclarations },
    { server, config }
  )

  const commsAdapter: ICommsAdapter = await createCommsAdapterComponent({ config, fetch, logs })

  const storageFolder = (await config.getString('STORAGE_FOLDER')) || 'contents'

  const bucket = await config.getString('BUCKET')
  const fs = createFsComponent()

  const storage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ fs, config }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs }, storageFolder)

  const snsArn = await config.getString('SNS_ARN')

  const status = await createStatusComponent({ logs, fetch, config })

  const sns: SnsComponent = {
    arn: snsArn
  }

  const dclNameChecker = await createDclNameChecker({
    config,
    fetch,
    logs,
    metrics
  })

  const limitsManager = await createLimitsManagerComponent({ config, fetch, logs })

  const worldsManager = await createWorldsManagerComponent({ logs, storage })

  const namePermissionChecker = await createWorldNamePermissionChecker({
    config,
    dclNameChecker,
    fetch,
    logs,
    worldsManager
  })

  const validator = createValidator({
    config,
    permissionChecker: namePermissionChecker,
    limitsManager,
    storage,
    worldsManager
  })

  return {
    dclNameChecker,
    commsAdapter,
    config,
    permissionChecker: namePermissionChecker,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    storage,
    limitsManager,
    sns,
    status,
    validator,
    worldsManager
  }
}
