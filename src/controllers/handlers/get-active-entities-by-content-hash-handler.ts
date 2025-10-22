import { HandlerContextWithPath } from '../../types'
import { IHttpServerComponent } from '@well-known-components/interfaces'
import { NotFoundError } from '@dcl/platform-server-commons'
import SQL from 'sql-template-strings'

/**
 * Returns all active entity IDs that contain the specified content hash
 * GET /contents/:hashId/active-entities
 */
export async function getActiveEntitiesByContentHashHandler(
  context: HandlerContextWithPath<'database' | 'nameDenyListChecker', '/contents/:hashId/active-entities'>
): Promise<IHttpServerComponent.IResponse> {
  const hashId = context.params.hashId
  const { database, nameDenyListChecker } = context.components

  // Query worlds table to find all entities that contain this content hash
  // The entity JSON contains a content array with {file, hash} objects
  const query = SQL`
    SELECT entity_id, name
    FROM worlds
    WHERE entity IS NOT NULL
      AND entity::jsonb @> '{"content": [{"hash": ${hashId}}]}'::jsonb
      AND blocked_since IS NULL
  `

  const queryResult = await database.query(query)
  
  // Filter out denylisted worlds (check each async)
  const rows = queryResult.rows as Array<{ entity_id: string; name: string }>
  const entityIds: string[] = []
  
  for (const row of rows) {
    const isAllowed = await nameDenyListChecker.checkNameDenyList(row.name)
    if (isAllowed) {
      entityIds.push(row.entity_id)
    }
  }

  if (entityIds.length === 0) {
    throw new NotFoundError('No active entities found containing this content hash')
  }

  return {
    status: 200,
    body: entityIds
  }
}

