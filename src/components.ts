import { createDotEnvConfigComponent } from "@well-known-components/env-config-provider"
import { createServerComponent, createStatusCheckComponent } from "@well-known-components/http-server"
import { createLogComponent } from "@well-known-components/logger"
import { createFetchComponent } from "./adapters/fetch"
import { createMetricsComponent } from "@well-known-components/metrics"
import { AppComponents, GlobalContext } from "./types"
import { metricDeclarations } from "./metrics"
import { metricDeclarations as theGraphMetricDeclarations } from '@well-known-components/thegraph-component'
import { HTTPProvider } from "eth-connect"
import {
  createAwsS3BasedFileSystemContentStorage,
  createFolderBasedFileSystemContentStorage,
  createFsComponent,
} from "@dcl/catalyst-storage"
import {createSubgraphComponent} from "@well-known-components/thegraph-component";

export const DEFAULT_MARKETPLACE_SUBGRAPH_URL = "https://api.thegraph.com/subgraphs/name/decentraland/marketplace";

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: [".env.default", ".env"] })

  const logs = createLogComponent()
  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors: {} })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createFetchComponent()
  const metrics = await createMetricsComponent({ ...metricDeclarations, ...theGraphMetricDeclarations}, { server, config })
  const ethereumProvider = new HTTPProvider("https://rpc.decentraland.org/mainnet?project=worlds-content-server", fetch)

  const storageFolder = (await config.getString("STORAGE_FOLDER")) || "contents"

  const bucket = await config.getString("BUCKET")
  const fs = createFsComponent()

  const storage = bucket
    ? await createAwsS3BasedFileSystemContentStorage({ fs, config }, bucket)
    : await createFolderBasedFileSystemContentStorage({ fs }, storageFolder)

  const subGraphUrl = await config.getString("MARKETPLACE_SUBGRAPH_URL") || DEFAULT_MARKETPLACE_SUBGRAPH_URL
  const marketplaceSubGraph = await createSubgraphComponent(
      { config, logs, metrics, fetch },
      subGraphUrl
  )

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    metrics,
    ethereumProvider,
    storage,
    marketplaceSubGraph,
  }
}
