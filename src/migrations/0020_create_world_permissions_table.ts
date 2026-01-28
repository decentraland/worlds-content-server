import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0020_create_world_permissions_table',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0020')

    logger.info('Creating world_permissions table for granular permissions')

    await database.query(`
      CREATE TABLE IF NOT EXISTS world_permissions (
        id SERIAL PRIMARY KEY,
        world_name VARCHAR NOT NULL,
        permission_type VARCHAR NOT NULL,
        address VARCHAR NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        UNIQUE(world_name, permission_type, address),
        CONSTRAINT fk_world_permissions_world_name
          FOREIGN KEY (world_name)
          REFERENCES worlds(name)
          ON DELETE CASCADE
      );
    `)

    logger.info('Creating indexes on world_permissions table')

    // Index for looking up all worlds a wallet can contribute to
    await database.query(`
      CREATE INDEX IF NOT EXISTS world_permissions_address_idx ON world_permissions(address);
    `)

    // Index for looking up by world and permission type
    await database.query(`
      CREATE INDEX IF NOT EXISTS world_permissions_world_permission_idx ON world_permissions(world_name, permission_type);
    `)

    logger.info('world_permissions table and indexes created successfully')
  }
}
