import { Migration } from '../types'

export const migration: Migration = {
  id: '0025_normalize_world_scene_parcels',
  async run({ database, logs }) {
    const logger = logs.getLogger('migration-0025')

    logger.info('Normalizing stored world scene parcels')

    const result = await database.query(`
      WITH normalized_world_scenes AS (
        SELECT
          world_scene.world_name,
          world_scene.entity_id,
          ARRAY_AGG(
            CASE
              WHEN parcel_entry.parcel ~ '^[[:space:]]*-?[0-9]+[[:space:]]*,[[:space:]]*-?[0-9]+[[:space:]]*$'
                THEN TRIM(SPLIT_PART(parcel_entry.parcel, ',', 1))::NUMERIC::TEXT
                  || ',' ||
                  TRIM(SPLIT_PART(parcel_entry.parcel, ',', 2))::NUMERIC::TEXT
              ELSE parcel_entry.parcel
            END
            ORDER BY parcel_entry.ordinality
          ) AS parcels
        FROM world_scenes AS world_scene
        CROSS JOIN LATERAL UNNEST(world_scene.parcels)
          WITH ORDINALITY AS parcel_entry(parcel, ordinality)
        GROUP BY world_scene.world_name, world_scene.entity_id
      )
      UPDATE world_scenes AS world_scene
      SET parcels = normalized_world_scene.parcels
      FROM normalized_world_scenes AS normalized_world_scene
      WHERE world_scene.world_name = normalized_world_scene.world_name
        AND world_scene.entity_id = normalized_world_scene.entity_id
        AND world_scene.parcels IS DISTINCT FROM normalized_world_scene.parcels
    `)

    logger.info(`Normalized parcels for ${result.rowCount ?? 0} world scenes`)
  }
}
