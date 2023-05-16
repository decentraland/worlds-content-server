import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'

export async function getIndexHandler(
  context: HandlerContextWithPath<'worldsIndexer', '/index'>
): Promise<IHttpServerComponent.IResponse> {
  const { worldsIndexer } = context.components

  const index = await worldsIndexer.getIndex()

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
