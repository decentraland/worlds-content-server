import { HandlerContextWithPath } from '../../types'
import {
  AboutResponse,
  AboutResponse_MinimapConfiguration,
  AboutResponse_SkyboxConfiguration
} from '../../proto/http-endpoints.gen'
import { streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { IConfigComponent } from '@well-known-components/interfaces'

export async function dclNameAboutHandler({
  params,
  url,
  components: { config, status, storage }
}: Pick<
  HandlerContextWithPath<'config' | 'status' | 'storage', '/world/:world_name/about'>,
  'components' | 'params' | 'url'
>) {
  // Retrieve
  const content = await storage.retrieve(`name-${params.world_name.toLowerCase()}`)
  if (!content) {
    return {
      status: 404,
      body: `World "${params.world_name}" has no scene deployed.`
    }
  }

  const buffer = await streamToBuffer(await content?.asStream())
  const { entityId } = JSON.parse(buffer.toString())

  const scene = await storage.retrieve(entityId)
  if (!scene) {
    return {
      status: 404,
      body: `Scene "${entityId}" not deployed in this server.`
    }
  }
  const sceneJson = JSON.parse((await streamToBuffer(await scene?.asStream())).toString())

  const baseUrl = ((await config.getString('HTTP_BASE_URL')) || `https://${url.host}`).toString()

  const urn = `urn:decentraland:entity:${entityId}?baseUrl=${baseUrl}/ipfs/`

  const networkId = await config.requireNumber('NETWORK_ID')
  const fixedAdapter = await resolveFixedAdapter(config, entityId, sceneJson, baseUrl)

  const globalScenesURN = await config.getString('GLOBAL_SCENES_URN')

  const contentStatus = await status.getContentStatus()
  const lambdasStatus = await status.getLambdasStatus()

  const minimap: AboutResponse_MinimapConfiguration = {
    enabled: sceneJson.metadata.worldConfiguration?.minimapVisible || false
  }
  if (sceneJson.metadata.worldConfiguration?.minimapVisible) {
    // TODO We may need to allow the scene creator to specify these values
    minimap.dataImage = 'https://api.decentraland.org/v1/minimap.png'
    minimap.estateImage = 'https://api.decentraland.org/v1/estatemap.png'
  }

  const skybox: AboutResponse_SkyboxConfiguration = {
    fixedHour: sceneJson.metadata.worldConfiguration?.skybox
  }

  const body: AboutResponse = {
    healthy: contentStatus.healthy && lambdasStatus.healthy,
    configurations: {
      networkId,
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

async function resolveFixedAdapter(config: IConfigComponent, entityId: string, sceneJson: any, baseUrl: string) {
  if (sceneJson.metadata.worldConfiguration?.fixedAdapter === 'offline:offline') {
    return 'offline:offline'
  }

  return `signed-login:${baseUrl}/get-comms-adapter/${entityId}`
}
