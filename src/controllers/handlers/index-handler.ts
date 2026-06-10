import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { getPaginationParams } from '@dcl/http-commons'

export async function getIndexHandler(
  context: HandlerContextWithPath<'config' | 'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, worldsIndexer } = context.components

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

  // Bound the amount of data retrieved per request (defaults to a capped page size). Callers
  // that need the full index can page through it with ?limit/&offset.
  const { limit, offset } = getPaginationParams(context.url.searchParams)
  const indexData = await worldsIndexer.getIndex({ limit, offset })

  // Transform to URLs
  for (const worldData of indexData.index) {
    for (const scene of worldData.scenes) {
      if (scene.thumbnail) {
        scene.thumbnail = `${baseUrl}/contents/${scene.thumbnail}`
      }
    }
  }

  return {
    status: 200,
    body: { data: indexData.index, lastUpdated: new Date(indexData.timestamp).toISOString() }
  }
}
