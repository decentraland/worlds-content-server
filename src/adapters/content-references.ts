import SQL from 'sql-template-strings'
import { AppComponents } from '../types'

/**
 * Reads all sources of content references in one SQL snapshot. Call under the exclusive content
 * lock before deleting candidates, so publication cannot race either this read or physical deletion.
 * @param database Application database.
 * @param cutoff Oldest live pending upload.
 * @param candidates Optional storage keys to check.
 * @returns Referenced keys, including soft-deleted scenes awaiting eviction.
 */
export async function getReferencedContentKeys(
  database: AppComponents['database'],
  cutoff: Date,
  candidates?: string[]
): Promise<Set<string>> {
  const query = SQL`
    WITH entities AS (
      SELECT entity_id, entity FROM world_scenes WHERE entity IS NOT NULL
      UNION ALL
      SELECT entity_id, entity FROM pending_scenes WHERE created_at >= ${cutoff}
    ), refs AS (
      SELECT entity_id AS hash FROM entities
      UNION ALL SELECT entity_id || '.auth' FROM entities
      UNION ALL
      SELECT content->>'hash' FROM entities,
        LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(entity->'content') = 'array'
          THEN entity->'content' ELSE '[]'::jsonb END) AS content
      UNION ALL SELECT thumbnail_hash FROM worlds WHERE thumbnail_hash IS NOT NULL
    ) SELECT DISTINCT hash FROM refs`
  if (candidates) query.append(SQL` WHERE hash = ANY(${candidates}::text[])`)
  const result = await database.query<{ hash: string }>(query)
  return new Set(result.rows.map((row) => row.hash))
}
