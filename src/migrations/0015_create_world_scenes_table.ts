import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0015_create_world_scenes_table',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0015')

    logger.info('Creating world_scenes table and migrating scene data (atomic transaction)')

    await database.query('BEGIN')

    try {
      // Step 1: Create the world_scenes table
      logger.info('Creating world_scenes table')
      await database.query(`
        CREATE TABLE IF NOT EXISTS world_scenes (
          world_name VARCHAR NOT NULL,
          entity_id VARCHAR NOT NULL,
          deployment_auth_chain JSON NOT NULL,
          entity JSONB NOT NULL,
          deployer VARCHAR NOT NULL,
          parcels TEXT[] NOT NULL,
          size BIGINT NOT NULL,
          created_at TIMESTAMP NOT NULL,
          PRIMARY KEY (world_name, entity_id),
          CONSTRAINT fk_world_name
            FOREIGN KEY (world_name)
            REFERENCES worlds(name)
            ON DELETE CASCADE
        );
      `)

      // Step 2: Create indexes
      logger.info('Creating indexes on world_scenes table')
      await database.query(`
        CREATE INDEX IF NOT EXISTS world_scenes_world_name_idx ON world_scenes(world_name);
      `)

      await database.query(`
        CREATE INDEX IF NOT EXISTS world_scenes_parcels_idx ON world_scenes USING GIN(parcels);
      `)

      await database.query(`
        CREATE INDEX IF NOT EXISTS world_scenes_deployer_idx ON world_scenes(deployer);
      `)

      // Step 3: Migrate existing scenes from worlds table using a single INSERT...SELECT
      logger.info('Migrating existing single-scene worlds to world_scenes table')

      const scenesResult = await database.query(`
        INSERT INTO world_scenes (
          world_name, entity_id, entity, deployment_auth_chain, 
          deployer, parcels, size, created_at
        )
        SELECT 
          name,
          entity_id,
          entity::jsonb,
          deployment_auth_chain,
          deployer,
          COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(entity::jsonb->'pointers')),
            ARRAY[]::text[]
          ),
          COALESCE(size, 0),
          created_at
        FROM worlds
        WHERE entity_id IS NOT NULL
        ON CONFLICT (world_name, entity_id) DO NOTHING
      `)

      await database.query('COMMIT')
      logger.info(
        `Successfully created world_scenes table and migrated ${scenesResult.rowCount} scenes (transaction committed)`
      )
    } catch (error: any) {
      await database.query('ROLLBACK')
      logger.error(`Migration failed, rolled back: ${error.message}`)
      throw error
    }
  }
}
