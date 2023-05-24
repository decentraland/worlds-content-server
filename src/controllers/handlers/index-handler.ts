import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function getIndexHandler(
  context: HandlerContextWithPath<'config' | 'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { config, worldsIndexer } = context.components

  const baseUrl = ((await config.getString('HTTP_BASE_URL')) || `https://${context.url.host}`).toString()

  const index = await worldsIndexer.getIndex()

  for (const worldName in index) {
    console.log(worldName, index[worldName].scenes)
    for (const scene of Object.values(index[worldName].scenes)) {
      // @ts-ignore
      scene['thumbnail'] = `${baseUrl}/contents/${scene.thumbnail}`
    }
  }

  return {
    status: 200,
    body: index
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
