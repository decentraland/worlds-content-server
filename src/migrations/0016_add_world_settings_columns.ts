import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0016_add_world_settings_columns',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0016')

    logger.info('Adding world_settings columns, migrating data, and dropping deprecated columns (atomic transaction)')

    await database.query('BEGIN')

    try {
      // Step 1: Add world_settings columns to worlds table
      logger.info('Adding world_settings columns to worlds table')
      await database.query(`
        ALTER TABLE worlds 
        ADD COLUMN IF NOT EXISTS world_settings JSON,
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS thumbnail_hash VARCHAR;
      `)

      // Step 2: Migrate world settings from entity metadata (before dropping entity column)
      logger.info('Migrating world settings from entity metadata')
      const settingsResult = await database.query(`
        UPDATE worlds
        SET 
          world_settings = jsonb_build_object(
            'name', COALESCE(entity->'metadata'->'worldConfiguration'->>'name', name),
            'spawnPoint', COALESCE(
              -- Priority 1: Get from spawnPoints[0].position (handle both single and multi position)
              (
                SELECT CASE
                  WHEN jsonb_typeof(sp->'position'->'x') = 'number' THEN
                    jsonb_build_object(
                      'x', (sp->'position'->'x')::numeric,
                      'y', (sp->'position'->'y')::numeric,
                      'z', (sp->'position'->'z')::numeric
                    )
                  WHEN jsonb_typeof(sp->'position'->'x') = 'array' THEN
                    jsonb_build_object(
                      'x', (sp->'position'->'x'->0)::numeric,
                      'y', (sp->'position'->'y'->0)::numeric,
                      'z', (sp->'position'->'z'->0)::numeric
                    )
                  ELSE NULL
                END
                FROM jsonb_array_elements(entity->'metadata'->'spawnPoints') AS sp
                LIMIT 1
              ),
              -- Priority 2: Parse from scene.base or scene.parcels[0]
              (
                SELECT jsonb_build_object(
                  'x', SPLIT_PART(parcel, ',', 1)::numeric,
                  'y', 0,
                  'z', SPLIT_PART(parcel, ',', 2)::numeric
                )
                FROM (
                  SELECT COALESCE(
                    entity->'metadata'->'scene'->>'base',
                    entity->'metadata'->'scene'->'parcels'->>0
                  ) as parcel
                ) p
                WHERE parcel IS NOT NULL
              ),
              -- Priority 3: Default to 0,0,0
              '{"x": 0, "y": 0, "z": 0}'::jsonb
            ),
            'miniMapConfig', entity->'metadata'->'worldConfiguration'->'miniMapConfig',
            'skyboxConfig', entity->'metadata'->'worldConfiguration'->'skyboxConfig',
            'fixedAdapter', entity->'metadata'->'worldConfiguration'->>'fixedAdapter'
          )::json,
          description = entity->'metadata'->'display'->>'description',
          thumbnail_hash = (
            SELECT c->>'hash' 
            FROM jsonb_array_elements(entity->'content') AS c 
            WHERE c->>'file' = entity->'metadata'->'display'->>'navmapThumbnail'
            LIMIT 1
          )
        WHERE entity IS NOT NULL
      `)

      // Step 3: Drop deprecated columns from worlds table (now stored in world_scenes)
      logger.info('Dropping deprecated columns from worlds table')
      await database.query(`
        ALTER TABLE worlds
        DROP COLUMN IF EXISTS entity_id,
        DROP COLUMN IF EXISTS entity,
        DROP COLUMN IF EXISTS deployment_auth_chain,
        DROP COLUMN IF EXISTS deployer,
        DROP COLUMN IF EXISTS size;
      `)

      // Drop the deprecated index on deployer column
      await database.query(`
        DROP INDEX IF EXISTS worlds_deployer_index;
      `)

      await database.query('COMMIT')
      logger.info(
        `Successfully added world_settings columns, updated ${settingsResult.rowCount} world settings, ` +
          `and dropped deprecated columns (transaction committed)`
      )
    } catch (error: any) {
      await database.query('ROLLBACK')
      logger.error(`Migration failed, rolled back: ${error.message}`)
      throw error
    }
  }
}
