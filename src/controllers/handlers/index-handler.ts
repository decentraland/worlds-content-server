import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

// Known consumers (opscli's AB-conversion snapshot, asset-bundle-encoder's download-worlds.sh)
// fetch /index without pagination and expect every world, so we default to a large page to keep
// that behavior effectively unchanged while still bounding the (uncached, N+1) query. Callers can
// page with ?limit/&offset; an explicit limit is clamped to the same maximum.
export const MAX_INDEX_LIMIT = 10_000

export async function getIndexHandler(
  context: HandlerContextWithPath<'config' | 'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, worldsIndexer } = context.components

  const baseUrl = (await config.getString('HTTP_BASE_URL')) || `${context.url.protocol}//${context.url.host}`

  const limitParam = parseInt(context.url.searchParams.get('limit') ?? '', 10)
  const offsetParam = parseInt(context.url.searchParams.get('offset') ?? '', 10)
  const limit = !isNaN(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_INDEX_LIMIT) : MAX_INDEX_LIMIT
  const offset = !isNaN(offsetParam) && offsetParam >= 0 ? offsetParam : 0
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
