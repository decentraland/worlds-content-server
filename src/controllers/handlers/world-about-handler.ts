import { HandlerContextWithPath } from '../../types'
import {
  AboutResponse,
  AboutResponse_MinimapConfiguration,
  AboutResponse_SkyboxConfiguration
} from '@dcl/protocol/out-js/decentraland/bff/http_endpoints.gen'
import { streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { ContentMapping } from '@dcl/schemas/dist/misc/content-mapping'
import { l1Contracts, L1Network } from '@dcl/catalyst-contracts'
import { WorldConfiguration } from '@dcl/schemas'

export async function worldAboutHandler({
  params,
  url,
  components: { config, status, storage, worldsManager }
}: Pick<
  HandlerContextWithPath<'config' | 'status' | 'storage' | 'worldsManager', '/world/:world_name/about'>,
  'components' | 'params' | 'url'
>) {
  const worldMetadata = await worldsManager.getMetadataForWorld(params.world_name)
  if (!worldMetadata || !worldMetadata.entityId) {
    return {
      status: 404,
      body: `World "${params.world_name}" has no scene deployed.`
    }
  }

  const scene = await storage.retrieve(worldMetadata.entityId)
  if (!scene) {
    return {
      status: 404,
      body: `Scene "${worldMetadata.entityId}" not deployed in this server.`
    }
  }
  const sceneJson = JSON.parse((await streamToBuffer(await scene?.asStream())).toString())

  const worldConfiguration: WorldConfiguration = worldMetadata.config || sceneJson.metadata.worldConfiguration!

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${url.protocol}//${url.host}`

  const urn = `urn:decentraland:entity:${worldMetadata.entityId}?=&baseUrl=${baseUrl}/contents/`

  const ethNetwork = await config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const roomPrefix = await config.requireString('COMMS_ROOM_PREFIX')
  const fixedAdapter = await resolveFixedAdapter(params.world_name, worldConfiguration, baseUrl, roomPrefix)

  const globalScenesURN = await config.getString('GLOBAL_SCENES_URN')

  const contentStatus = await status.getContentStatus()
  const lambdasStatus = await status.getLambdasStatus()

  function urlForFile(filename: string | undefined, defaultImage: string = ''): string {
    if (filename) {
      const file = sceneJson.content.find((content: ContentMapping) => content.file === filename)
      if (file) {
        return `${baseUrl}/contents/${file.hash}`
      }
    }
    return defaultImage
  }

  const minimap: AboutResponse_MinimapConfiguration = {
    enabled: worldConfiguration.minimapVisible || worldConfiguration.miniMapConfig?.visible || false
  }
  if (minimap.enabled || worldConfiguration.miniMapConfig?.dataImage) {
    minimap.dataImage = urlForFile(
      worldConfiguration.miniMapConfig?.dataImage,
      'https://api.decentraland.org/v1/minimap.png'
    )
  }
  if (minimap.enabled || worldConfiguration.miniMapConfig?.estateImage) {
    minimap.estateImage = urlForFile(
      worldConfiguration.miniMapConfig?.estateImage,
      'https://api.decentraland.org/v1/estatemap.png'
    )
  }

  const skybox: AboutResponse_SkyboxConfiguration = {
    fixedHour: worldConfiguration.skyboxConfig?.fixedTime || worldConfiguration.skybox,
    textures: worldConfiguration.skyboxConfig?.textures
      ? worldConfiguration.skyboxConfig?.textures.map((texture: string) => urlForFile(texture))
      : (undefined as any)
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
      realmName: params.world_name
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
  worldConfiguration: WorldConfiguration,
  baseUrl: string,
  roomPrefix: string
) {
  if (worldConfiguration?.fixedAdapter === 'offline:offline') {
    return 'offline:offline'
  }

  return `signed-login:${baseUrl}/get-comms-adapter/${roomPrefix}${worldName.toLowerCase()}`
}
