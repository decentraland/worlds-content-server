import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0022_normalize_permission_parcels',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0022')

    logger.info('Creating world_permission_parcels table for normalized parcel storage')

    await database.query(`
      CREATE TABLE IF NOT EXISTS world_permission_parcels (
        permission_id INT NOT NULL REFERENCES world_permissions(id) ON DELETE CASCADE,
        parcel VARCHAR NOT NULL,
        PRIMARY KEY (permission_id, parcel)
      );
    `)

    // Index for efficient parcel lookups
    await database.query(`
      CREATE INDEX IF NOT EXISTS world_permission_parcels_parcel_idx ON world_permission_parcels(parcel);
    `)

    logger.info('world_permission_parcels table created successfully')
  }
}
