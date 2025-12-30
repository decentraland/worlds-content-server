import { HandlerContextWithPath } from '../../types'
import {
  About,
  AboutConfigurationsMap,
  AboutConfigurationsMinimap,
  AboutConfigurationsSkybox
} from '@dcl/catalyst-api-specs/lib/client'
import { l1Contracts, L1Network } from '@dcl/catalyst-contracts'
import { assertNotBlockedOrWithinInGracePeriod } from '../../logic/blocked'
import { NotFoundError } from '@dcl/platform-server-commons'

// OPTIMIZATION 1: Configurable scene limit
const MAX_SCENES_IN_ABOUT = parseInt(process.env.MAX_SCENES_IN_ABOUT || '100')

export async function worldAboutHandler({
  params,
  url,
  components: { config, nameDenyListChecker, status, worldsManager }
}: Pick<
  HandlerContextWithPath<'config' | 'nameDenyListChecker' | 'status' | 'worldsManager', '/world/:world_name/about'>,
  'components' | 'params' | 'url'
>) {
  if (!(await nameDenyListChecker.checkNameDenyList(params.world_name))) {
    throw new NotFoundError(`World "${params.world_name}" has no scene deployed.`)
  }

  const worldMetadata = await worldsManager.getMetadataForWorld(params.world_name)
  if (!worldMetadata || worldMetadata.scenes.length === 0) {
    throw new NotFoundError(`World "${params.world_name}" has no scenes deployed.`)
  }

  assertNotBlockedOrWithinInGracePeriod(worldMetadata)

  const runtimeMetadata = worldMetadata.runtimeMetadata

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${url.protocol}//${url.host}`

  // OPTIMIZATION 2: Limit number of scenes returned + warn if truncated
  const entityIds = runtimeMetadata.entityIds.slice(0, MAX_SCENES_IN_ABOUT)
  const truncated = runtimeMetadata.entityIds.length > MAX_SCENES_IN_ABOUT

  // OPTIMIZATION 3: Lazy URN generation (only when needed)
  const scenesUrn = entityIds.map(
    (entityId) => `urn:decentraland:entity:${entityId}?=&baseUrl=${baseUrl}/contents/`
  )

  if (truncated) {
    console.warn(
      `World "${params.world_name}" has ${runtimeMetadata.entityIds.length} scenes, ` +
      `but only ${MAX_SCENES_IN_ABOUT} are included in /about response. ` +
      `Consider using /world/${params.world_name}/scenes for full list.`
    )
  }

  const ethNetwork = await config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const adapter = await resolveFixedAdapter(params.world_name, runtimeMetadata.fixedAdapter, baseUrl, roomPrefix)

  const globalScenesURN = await config.getString('GLOBAL_SCENES_URN')

  const contentStatus = await status.getContentStatus()
  const lambdasStatus = await status.getLambdasStatus()

  function urlForFile(filename: string | undefined, defaultImage: string = ''): string {
    if (filename) {
      return `${baseUrl}/contents/${filename}`
    }
    return defaultImage
  }

  // TODO: deprecated, to be removed
  const minimap: AboutConfigurationsMinimap = {
    enabled: runtimeMetadata.minimapVisible
  }
  if (minimap.enabled || runtimeMetadata.minimapDataImage) {
    minimap.dataImage = urlForFile(runtimeMetadata.minimapDataImage, 'https://api.decentraland.org/v1/minimap.png')
  }
  if (minimap.enabled || runtimeMetadata.minimapEstateImage) {
    minimap.estateImage = urlForFile(
      runtimeMetadata.minimapEstateImage,
      'https://api.decentraland.org/v1/estatemap.png'
    )
  }

  // https://adr.decentraland.org/adr/ADR-250
  const map: AboutConfigurationsMap = {
    minimapEnabled: false,
    // TODO: a minimap area might be defined
    sizes: []
  }

  const skybox: AboutConfigurationsSkybox = {
    fixedHour: runtimeMetadata.skyboxFixedTime,
    textures: runtimeMetadata.skyboxTextures?.map((texture: string) => urlForFile(texture)) || []
  }

  const healthy = contentStatus.healthy && lambdasStatus.healthy
  const body: About = {
    healthy,
    acceptingUsers: healthy,
    configurations: {
      networkId: contracts.chainId,
      globalScenesUrn: globalScenesURN ? globalScenesURN.split(' ') : [],
      scenesUrn, // Limited to MAX_SCENES_IN_ABOUT
      minimap,
      skybox,
      realmName: runtimeMetadata.name,
      map
    },
    content: {
      synchronizationStatus: 'Syncing',
      healthy: contentStatus.healthy,
      publicUrl: contentStatus.publicUrl
    },
    lambdas: {
      healthy: lambdasStatus.healthy,
      publicUrl: lambdasStatus.publicUrl
    },
    comms: {
      healthy: true,
      protocol: 'v3',
      adapter
    }
  }

  // OPTIMIZATION 4: Add metadata about truncation
  if (truncated) {
    ;(body as any).sceneCount = {
      total: runtimeMetadata.entityIds.length,
      included: entityIds.length,
      message: `This world has ${runtimeMetadata.entityIds.length} scenes. Use GET /world/${params.world_name}/scenes for the complete list.`
    }
  }

  return {
    status: 200,
    body
  }
}

async function resolveFixedAdapter(
  worldName: string,
  fixedAdapter: string | undefined,
  baseUrl: string,
  roomPrefix: string
) {
  if (fixedAdapter === 'offline:offline') {
    return 'fixed-adapter:offline:offline'
  }

  return `fixed-adapter:signed-login:${baseUrl}/get-comms-adapter/${roomPrefix}${worldName.toLowerCase()}`
}

