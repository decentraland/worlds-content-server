import { Migration } from '../types'

type ParcelCollision = {
  worldName: string
  parcel: string
  entityIds: string[]
}

class WorldSceneParcelCollisionError extends Error {
  constructor(collisions: ParcelCollision[]) {
    const summary = collisions
      .map(({ worldName, parcel, entityIds }) => `${worldName}:${parcel} (${entityIds.join(', ')})`)
      .join('; ')
    super(`Cannot normalize world scene parcels because deployed scenes would overlap: ${summary}`)
    this.name = 'WorldSceneParcelCollisionError'
  }
}

class WorldSceneParcelMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldSceneParcelMigrationError'
  }
}

export const migration: Migration = {
  id: '0025_normalize_world_scene_parcels',
  async run({ database, logs }) {
    const logger = logs.getLogger('migration-0025')

    logger.info('Normalizing stored world scene parcels')

    const result = await database.query<{
      updated_count: string
      collisions: Array<{ world_name: string; parcel: string; entity_ids: string[] }>
    }>(`
      WITH normalized_parcels AS (
        SELECT
          world_scene.world_name,
          world_scene.entity_id,
          world_scene.status,
          CASE
            WHEN parcel_entry.parcel ~ '^[[:space:]]*-?[0-9]+[[:space:]]*,[[:space:]]*-?[0-9]+[[:space:]]*$'
              THEN TRIM(SPLIT_PART(parcel_entry.parcel, ',', 1))::NUMERIC::TEXT
                || ',' ||
                TRIM(SPLIT_PART(parcel_entry.parcel, ',', 2))::NUMERIC::TEXT
            ELSE parcel_entry.parcel
          END AS parcel,
          parcel_entry.ordinality
        FROM world_scenes AS world_scene
        CROSS JOIN LATERAL UNNEST(world_scene.parcels)
          WITH ORDINALITY AS parcel_entry(parcel, ordinality)
      ),
      deduplicated_parcels AS (
        SELECT world_name, entity_id, status, parcel, MIN(ordinality) AS ordinality
        FROM normalized_parcels
        GROUP BY world_name, entity_id, status, parcel
      ),
      deployed_collisions AS (
        SELECT
          world_name,
          parcel,
          ARRAY_AGG(entity_id ORDER BY entity_id) AS entity_ids
        FROM deduplicated_parcels
        WHERE status = 'DEPLOYED'
        GROUP BY world_name, parcel
        HAVING COUNT(DISTINCT entity_id) > 1
      ),
      normalized_world_scenes AS (
        SELECT
          world_name,
          entity_id,
          ARRAY_AGG(parcel ORDER BY ordinality) AS parcels
        FROM deduplicated_parcels
        GROUP BY world_name, entity_id
      ),
      updated_world_scenes AS (
        UPDATE world_scenes AS world_scene
        SET parcels = normalized_world_scene.parcels
        FROM normalized_world_scenes AS normalized_world_scene
        WHERE world_scene.world_name = normalized_world_scene.world_name
          AND world_scene.entity_id = normalized_world_scene.entity_id
          AND world_scene.parcels IS DISTINCT FROM normalized_world_scene.parcels
          AND NOT EXISTS (SELECT 1 FROM deployed_collisions)
        RETURNING world_scene.entity_id
      )
      SELECT
        (SELECT COUNT(*)::TEXT FROM updated_world_scenes) AS updated_count,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'world_name', world_name,
                'parcel', parcel,
                'entity_ids', entity_ids
              )
              ORDER BY world_name, parcel
            )
            FROM deployed_collisions
          ),
          '[]'::JSON
        ) AS collisions
    `)

    const migrationResult = result.rows[0]
    if (!migrationResult) {
      throw new WorldSceneParcelMigrationError('World scene parcel normalization returned no result')
    }

    const collisions = migrationResult.collisions.map((collision) => ({
      worldName: collision.world_name,
      parcel: collision.parcel,
      entityIds: collision.entity_ids
    }))
    if (collisions.length > 0) {
      logger.error('World scene parcel normalization found deployed scene collisions', {
        collisions: collisions.length.toString()
      })
      throw new WorldSceneParcelCollisionError(collisions)
    }

    logger.info(`Normalized parcels for ${migrationResult.updated_count} world scenes`)
  }
}
