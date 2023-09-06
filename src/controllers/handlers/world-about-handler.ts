import { HandlerContextWithPath, NotFoundError } from '../../types'
import {
  AboutResponse,
  AboutResponse_MinimapConfiguration,
  AboutResponse_SkyboxConfiguration
} from '@dcl/protocol/out-js/decentraland/bff/http_endpoints.gen'
import { l1Contracts, L1Network } from '@dcl/catalyst-contracts'

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
  if (!worldMetadata || !worldMetadata.entityId) {
    throw new NotFoundError(`World "${params.world_name}" has no scene deployed.`)
  }

  const runtimeMetadata = worldMetadata.runtimeMetadata

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${url.protocol}//${url.host}`

  const urn = `urn:decentraland:entity:${worldMetadata.entityId}?=&baseUrl=${baseUrl}/contents/`

  const ethNetwork = await config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const fixedAdapter = await resolveFixedAdapter(params.world_name, runtimeMetadata.fixedAdapter, baseUrl, roomPrefix)

  const globalScenesURN = await config.getString('GLOBAL_SCENES_URN')

  const contentStatus = await status.getContentStatus()
  const lambdasStatus = await status.getLambdasStatus()

  function urlForFile(filename: string | undefined, defaultImage: string = ''): string {
    if (filename) {
      return `${baseUrl}/contents/${filename}`
    }
    return defaultImage
  }

  const minimap: AboutResponse_MinimapConfiguration = {
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

  const skybox: AboutResponse_SkyboxConfiguration = {
    fixedHour: runtimeMetadata.skyboxFixedTime,
    textures: runtimeMetadata.skyboxTextures?.map((texture: string) => urlForFile(texture)) || []
  }

  const healthy = contentStatus.healthy && lambdasStatus.healthy
  const body: AboutResponse = {
    healthy,
    acceptingUsers: healthy,
    configurations: {
      networkId: contracts.chainId,
      globalScenesUrn: globalScenesURN ? globalScenesURN.split(' ') : [],
      scenesUrn: [urn],
      minimap,
      skybox,
      realmName: runtimeMetadata.name
    },
    content: {
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
      fixedAdapter: fixedAdapter
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
    return 'offline:offline'
  }

  return `signed-login:${baseUrl}/get-comms-adapter/${roomPrefix}${worldName.toLowerCase()}`
}
