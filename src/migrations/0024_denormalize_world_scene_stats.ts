import { Migration } from '../types'

export const migration: Migration = {
  id: '0024',
  run: async ({ database }) => {
    await database.query(`
      ALTER TABLE worlds ADD COLUMN last_deployed_at TIMESTAMP;
      ALTER TABLE worlds ADD COLUMN deployed_scene_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE worlds ADD COLUMN scene_min_x INTEGER;
      ALTER TABLE worlds ADD COLUMN scene_max_x INTEGER;
      ALTER TABLE worlds ADD COLUMN scene_min_y INTEGER;
      ALTER TABLE worlds ADD COLUMN scene_max_y INTEGER;

      -- Backfill from existing world_scenes data
      UPDATE worlds w SET
        last_deployed_at = sub.last_deployed_at,
        deployed_scene_count = COALESCE(sub.scene_count, 0),
        scene_min_x = sub.min_x,
        scene_max_x = sub.max_x,
        scene_min_y = sub.min_y,
        scene_max_y = sub.max_y
      FROM (
        SELECT
          ws.world_name,
          MAX(ws.created_at) as last_deployed_at,
          COUNT(DISTINCT ws.entity_id)::integer as scene_count,
          MIN(SPLIT_PART(parcel, ',', 1)::integer) as min_x,
          MAX(SPLIT_PART(parcel, ',', 1)::integer) as max_x,
          MIN(SPLIT_PART(parcel, ',', 2)::integer) as min_y,
          MAX(SPLIT_PART(parcel, ',', 2)::integer) as max_y
        FROM world_scenes ws, UNNEST(ws.parcels) as parcel
        WHERE ws.status = 'DEPLOYED'
        GROUP BY ws.world_name
      ) sub
      WHERE w.name = sub.world_name;

      -- Index for ORDER BY last_deployed_at
      CREATE INDEX worlds_last_deployed_at_idx ON worlds(last_deployed_at);
    `)
  }
}
