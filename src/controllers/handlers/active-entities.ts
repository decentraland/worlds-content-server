import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/http-commons'

const MAX_POINTERS = 50

export async function activeEntitiesHandler(
  context: HandlerContextWithPath<'nameDenyListChecker' | 'worldsManager', '/entities/active'>
): Promise<IHttpServerComponent.IResponse> {
  const { nameDenyListChecker, worldsManager } = context.components

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

  if (pointers.length > MAX_POINTERS) {
    throw new InvalidRequestError(`Maximum ${MAX_POINTERS} pointers allowed per request`)
  }

  const uniquePointers = new Set(pointers.map((p) => p.toLowerCase()))
  const allowedPointers: string[] = []
  const bannedWorlds: string[] = []

  for (const pointer of uniquePointers) {
    const isAllowed = await nameDenyListChecker.checkNameDenyList(pointer)
    if (isAllowed) {
      allowedPointers.push(pointer)
    } else {
      bannedWorlds.push(pointer)
    }
  }

  const entities = await worldsManager.getEntityForWorlds(allowedPointers)

  return {
    status: 200,
    body: entities
  }
}
