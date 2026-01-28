import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0017_add_world_settings_columns',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0017')

    logger.info('Adding world settings columns and migrating data from scenes')

    // Single atomic query that:
    // 1. Adds columns if they don't exist
    // 2. Migrates data from the latest scene metadata for each world
    await database.query(`
      -- Add new columns
      ALTER TABLE worlds 
        ADD COLUMN IF NOT EXISTS title VARCHAR,
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS content_rating VARCHAR,
        ADD COLUMN IF NOT EXISTS skybox_time INTEGER,
        ADD COLUMN IF NOT EXISTS categories TEXT[],
        ADD COLUMN IF NOT EXISTS single_player BOOLEAN,
        ADD COLUMN IF NOT EXISTS show_in_places BOOLEAN,
        ADD COLUMN IF NOT EXISTS thumbnail_hash VARCHAR;

      -- Migrate data from latest scene metadata
      UPDATE worlds w
      SET 
        title = COALESCE(w.title, scene_data.title),
        description = COALESCE(w.description, scene_data.description),
        skybox_time = COALESCE(w.skybox_time, scene_data.skybox_time),
        categories = COALESCE(w.categories, scene_data.categories),
        thumbnail_hash = COALESCE(w.thumbnail_hash, scene_data.thumbnail_hash)
      FROM (
        SELECT DISTINCT ON (world_name)
          world_name,
          entity->'metadata'->'display'->>'title' as title,
          entity->'metadata'->'display'->>'description' as description,
          (entity->'metadata'->'worldConfiguration'->'skyboxConfig'->>'fixedTime')::integer as skybox_time,
          CASE 
            WHEN jsonb_array_length(COALESCE(entity->'metadata'->'tags', '[]'::jsonb)) > 0 
            THEN ARRAY(SELECT jsonb_array_elements_text(entity->'metadata'->'tags'))
            ELSE NULL 
          END as categories,
          -- Extract thumbnail hash by finding content entry matching navmapThumbnail
          (
            SELECT content_item->>'hash'
            FROM jsonb_array_elements(entity->'content') as content_item
            WHERE content_item->>'file' = entity->'metadata'->'display'->>'navmapThumbnail'
            LIMIT 1
          ) as thumbnail_hash
        FROM world_scenes
        ORDER BY world_name, created_at DESC
      ) scene_data
      WHERE w.name = scene_data.world_name;
    `)

    logger.info('Successfully added world settings columns and migrated data from scenes')
  }
}
