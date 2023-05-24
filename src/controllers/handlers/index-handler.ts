import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function getIndexHandler(
  context: HandlerContextWithPath<'config' | 'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, worldsIndexer } = context.components

  const baseUrl = ((await config.getString('HTTP_BASE_URL')) || `https://${context.url.host}`).toString()

  const index = await worldsIndexer.getIndex()

  // Transform to URLs
  for (const worldData of index) {
    for (const scene of worldData.scenes) {
      scene.thumbnail = `${baseUrl}/contents/${scene.thumbnail}`
    }
  }

  return {
    status: 200,
    body: { data: index }
  }
}

export async function postIndexHandler(
  context: HandlerContextWithPath<'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { worldsIndexer } = context.components

  await worldsIndexer.createIndex()

  return {
    status: 301,
    headers: {
      location: '/index'
    }
  }
}
