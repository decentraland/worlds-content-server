import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/platform-server-commons'

const MAX_POINTERS = 50

export async function activeEntitiesHandler(
  context: HandlerContextWithPath<'logs' | 'nameDenyListChecker' | 'worldsManager', '/entities/active'>
): Promise<IHttpServerComponent.IResponse> {
  const { logs, nameDenyListChecker, worldsManager } = context.components
  const logger = logs.getLogger('active-entities-handler')

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

  // Deduplicate pointers (case-insensitive)
  const uniquePointers = Array.from(new Set(pointers.map((p) => p.toLowerCase())))

  // Filter out banned worlds BEFORE fetching
  const allowedPointers = []
  const bannedWorlds = []

  for (const pointer of uniquePointers) {
    const isAllowed = await nameDenyListChecker.checkNameDenyList(pointer)
    if (isAllowed) {
      allowedPointers.push(pointer)
    } else {
      bannedWorlds.push(pointer)
    }
  }

  // Log banned worlds if any
  if (bannedWorlds.length > 0) {
    logger.warn(`Filtered out ${bannedWorlds.length} banned worlds from request: ${bannedWorlds.join(', ')}`, {
      requestedCount: uniquePointers.length,
      allowedCount: allowedPointers.length
    })
  }

  // Fetch entities only for allowed worlds
  const results = await Promise.all(allowedPointers.map((pointer) => worldsManager.getEntityForWorld(pointer)))

  // Filter out null/undefined results (worlds that don't exist)
  const entities = results.filter(Boolean)

  return {
    status: 200,
    body: entities
  }
}
