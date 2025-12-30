import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0015_create_world_scenes_table',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0015')

    logger.info('Creating world_scenes table for multi-scene support')

    await database.query(`
      CREATE TABLE IF NOT EXISTS world_scenes (
        id SERIAL PRIMARY KEY,
        world_name VARCHAR NOT NULL,
        entity_id VARCHAR NOT NULL,
        deployment_auth_chain JSON NOT NULL,
        entity JSON NOT NULL,
        deployer VARCHAR NOT NULL,
        parcels TEXT[] NOT NULL,
        size BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        UNIQUE(world_name, entity_id),
        CONSTRAINT fk_world_name
          FOREIGN KEY (world_name)
          REFERENCES worlds(name)
          ON DELETE CASCADE
      );
    `)

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

    logger.info('world_scenes table and indexes created successfully')
  }
}

