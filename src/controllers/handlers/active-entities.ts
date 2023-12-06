import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export async function activeEntitiesHandler(
  context: HandlerContextWithPath<'worldsManager', '/entities/active'>
): Promise<IHttpServerComponent.IResponse> {
  const body = await context.request.json()
  if (!body || typeof body !== 'object' || !Array.isArray(body.pointers)) {
    throw new InvalidRequestError('Invalid request. Request body is not valid')
  }

  const pointers: string[] = []

  for (const pointer of body.pointers) {
    if (typeof pointer === 'string' && pointer.length > 0) {
      pointers.push(pointer)
    }
  }

  if (pointers.length > 1) {
    return {
      status: 403,
      body: { message: 'Worlds content server only answers one pointer at a time to prevent abuse' }
    }
  }

  const result = await context.components.worldsManager.getEntityForWorld(pointers[0])

  return {
    status: 200,
    body: [result].filter(Boolean)
  }
}
