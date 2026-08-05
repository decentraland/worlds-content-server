import { Migration } from '../types'

type ParcelCollision = {
  worldName: string
  parcel: string
  entityIds: string[]
}

type InvalidDeployedParcel = {
  worldName: string
  entityId: string
  parcel: string
}

class WorldSceneParcelIntegrityError extends Error {
  constructor(collisions: ParcelCollision[], invalidParcels: InvalidDeployedParcel[]) {
    const issues: string[] = []
    if (collisions.length > 0) {
      const collisionSummary = collisions
        .map(({ worldName, parcel, entityIds }) => `${worldName}:${parcel} (${entityIds.join(', ')})`)
        .join('; ')
      issues.push(`deployed scenes would overlap: ${collisionSummary}`)
    }
    if (invalidParcels.length > 0) {
      const invalidParcelSummary = invalidParcels
        .map(({ worldName, entityId, parcel }) => `${worldName}:${entityId} (${JSON.stringify(parcel)})`)
        .join('; ')
      issues.push(`deployed scenes contain invalid parcels: ${invalidParcelSummary}`)
    }
    super(`Cannot normalize world scene parcels because ${issues.join('; ')}`)
    this.name = 'WorldSceneParcelIntegrityError'
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
      invalid_parcels: Array<{ world_name: string; entity_id: string; parcel: string }>
    }>(`
      WITH parcel_entries AS (
        SELECT
          world_scene.world_name,
          world_scene.entity_id,
          world_scene.status,
          parcel_entry.parcel AS original_parcel,
          TRIM(SPLIT_PART(parcel_entry.parcel, ',', 1)) AS x,
          TRIM(SPLIT_PART(parcel_entry.parcel, ',', 2)) AS y,
          parcel_entry.parcel ~ '^[[:space:]]*-?[0-9]+[[:space:]]*,[[:space:]]*-?[0-9]+[[:space:]]*$'
            AS has_coordinate_shape,
          parcel_entry.ordinality
        FROM world_scenes AS world_scene
        CROSS JOIN LATERAL UNNEST(world_scene.parcels)
          WITH ORDINALITY AS parcel_entry(parcel, ordinality)
      ),
      validated_parcels AS (
        SELECT
          *,
          CASE
            WHEN has_coordinate_shape THEN
              CASE
                WHEN LENGTH(x) <= 32 AND LENGTH(y) <= 32 THEN
                  x::NUMERIC BETWEEN -150 AND 150 AND y::NUMERIC BETWEEN -150 AND 150
                ELSE FALSE
              END
            ELSE FALSE
          END AS is_valid
        FROM parcel_entries
      ),
      normalized_parcels AS (
        SELECT
          world_name,
          entity_id,
          status,
          original_parcel,
          CASE WHEN is_valid THEN x::NUMERIC::TEXT || ',' || y::NUMERIC::TEXT ELSE original_parcel END AS parcel,
          ordinality,
          is_valid
        FROM validated_parcels
      ),
      invalid_deployed_parcels AS (
        SELECT DISTINCT world_name, entity_id, original_parcel AS parcel
        FROM normalized_parcels
        WHERE status = 'DEPLOYED' AND NOT is_valid
      ),
      deduplicated_parcels AS (
        SELECT world_name, entity_id, status, parcel, is_valid, MIN(ordinality) AS ordinality
        FROM normalized_parcels
        GROUP BY world_name, entity_id, status, parcel, is_valid
      ),
      deployed_collisions AS (
        SELECT
          world_name,
          parcel,
          ARRAY_AGG(entity_id ORDER BY entity_id) AS entity_ids
        FROM deduplicated_parcels
        WHERE status = 'DEPLOYED' AND is_valid
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
          AND NOT EXISTS (SELECT 1 FROM invalid_deployed_parcels)
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
        ) AS collisions,
        COALESCE(
          (
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'world_name', world_name,
                'entity_id', entity_id,
                'parcel', parcel
              )
              ORDER BY world_name, entity_id, parcel
            )
            FROM invalid_deployed_parcels
          ),
          '[]'::JSON
        ) AS invalid_parcels
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
    const invalidParcels = migrationResult.invalid_parcels.map((invalidParcel) => ({
      worldName: invalidParcel.world_name,
      entityId: invalidParcel.entity_id,
      parcel: invalidParcel.parcel
    }))
    if (collisions.length > 0 || invalidParcels.length > 0) {
      logger.error('World scene parcel normalization found deployed scene integrity issues', {
        collisions: collisions.length.toString(),
        invalidParcels: invalidParcels.length.toString()
      })
      throw new WorldSceneParcelIntegrityError(collisions, invalidParcels)
    }

    logger.info(`Normalized parcels for ${migrationResult.updated_count} world scenes`)
  }
}
