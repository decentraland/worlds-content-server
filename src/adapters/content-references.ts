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
  return queryReferencedKeys(database, cutoff, candidates)
}

/**
 * Reads the keys referenced by published content: world scenes (including soft-deleted ones awaiting
 * eviction) and world thumbnails. Pending uploads don't count.
 * @param database Application database.
 * @param candidates Storage keys to check.
 * @returns The candidates published content references.
 */
export async function getPublishedContentKeys(
  database: AppComponents['database'],
  candidates: string[]
): Promise<Set<string>> {
  // Looks each candidate up through world_scenes_content_hashes_idx; the expression must match the index's.
  const result = await database.query<{ hash: string }>(SQL`
    SELECT c.hash FROM unnest(${candidates}::text[]) AS c(hash)
    WHERE EXISTS (
        SELECT 1 FROM world_scenes ws
        WHERE jsonb_path_query_array(ws.entity, '$.content[*].hash') @> jsonb_build_array(c.hash)
      )
      OR EXISTS (
        SELECT 1 FROM world_scenes ws
        WHERE ws.entity IS NOT NULL AND ws.entity_id IN (c.hash, regexp_replace(c.hash, '\\.auth$', ''))
      )
      OR EXISTS (SELECT 1 FROM worlds w WHERE w.thumbnail_hash = c.hash)`)
  return new Set(result.rows.map((row) => row.hash))
}

async function queryReferencedKeys(
  database: AppComponents['database'],
  pendingCutoff: Date | undefined,
  candidates?: string[]
): Promise<Set<string>> {
  const query = SQL`
    WITH entities AS (
      SELECT entity_id, entity FROM world_scenes WHERE entity IS NOT NULL`
  if (pendingCutoff) {
    query.append(SQL`
      UNION ALL
      SELECT entity_id, entity FROM pending_scenes WHERE created_at >= ${pendingCutoff}`)
  }
  query.append(SQL`
    ), refs AS (
      SELECT entity_id AS hash FROM entities
      UNION ALL SELECT entity_id || '.auth' FROM entities
      UNION ALL
      SELECT content->>'hash' FROM entities,
        LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(entity->'content') = 'array'
          THEN entity->'content' ELSE '[]'::jsonb END) AS content
      UNION ALL SELECT thumbnail_hash FROM worlds WHERE thumbnail_hash IS NOT NULL
    ) SELECT DISTINCT hash FROM refs`)
  if (candidates) query.append(SQL` WHERE hash = ANY(${candidates}::text[])`)
  const result = await database.query<{ hash: string }>(query)
  return new Set(result.rows.map((row) => row.hash))
}
