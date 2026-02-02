import { HandlerContextWithPath } from '../../types'
import {
  About,
  AboutConfigurationsMap,
  AboutConfigurationsMinimap,
  AboutConfigurationsSkybox
} from '@dcl/catalyst-api-specs/lib/client'
import { l1Contracts, L1Network } from '@dcl/catalyst-contracts'
import { NotFoundError } from '@dcl/http-commons'
import { WorldBlockedError } from '../../logic/worlds'

export async function worldAboutHandler({
  params,
  url,
  components: { config, nameDenyListChecker, status, worldsManager, worlds }
}: Pick<
  HandlerContextWithPath<
    'config' | 'nameDenyListChecker' | 'status' | 'worldsManager' | 'worlds',
    '/world/:world_name/about'
  >,
  'components' | 'params' | 'url'
>) {
  if (!(await nameDenyListChecker.checkNameDenyList(params.world_name))) {
    throw new NotFoundError(`World "${params.world_name}" has no scene deployed.`)
  }

  const worldMetadata = await worldsManager.getMetadataForWorld(params.world_name)
  if (!worldMetadata || worldMetadata.scenes.length === 0) {
    throw new NotFoundError(`World "${params.world_name}" has no scenes deployed.`)
  }

  if (worlds.isWorldBlocked(worldMetadata.blockedSince)) {
    throw new WorldBlockedError(params.world_name, worldMetadata.blockedSince!)
  }

  const runtimeMetadata = worldMetadata.runtimeMetadata

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${url.protocol}//${url.host}`

  // Create URNs for all scenes in the world
  const scenesUrn = runtimeMetadata.entityIds.map(
    (entityId) => `urn:decentraland:entity:${entityId}?=&baseUrl=${baseUrl}/contents/`
  )

  const ethNetwork = await config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const adapter = resolveFixedAdapter(params.world_name, runtimeMetadata.fixedAdapter, baseUrl, roomPrefix)

  const globalScenesURN = await config.getString('GLOBAL_SCENES_URN')

  const [contentStatus, lambdasStatus] = await Promise.all([status.getContentStatus(), status.getLambdasStatus()])

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
  const body: About & { spawnCoordinates?: string | null } = {
    healthy,
    acceptingUsers: healthy,
    spawnCoordinates: worldMetadata.spawnCoordinates,
    configurations: {
      networkId: contracts.chainId,
      globalScenesUrn: globalScenesURN ? globalScenesURN.split(' ') : [],
      scenesUrn, // Multiple scenes support
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

  return {
    status: 200,
    body
  }
}

function resolveFixedAdapter(worldName: string, fixedAdapter: string | undefined, baseUrl: string, roomPrefix: string) {
  if (fixedAdapter === 'offline:offline') {
    return 'fixed-adapter:offline:offline'
  }

  return `fixed-adapter:signed-login:${baseUrl}/get-comms-adapter/${roomPrefix}${worldName.toLowerCase()}`
}
