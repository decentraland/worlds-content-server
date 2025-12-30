import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0016_add_world_settings_columns',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0016')

    logger.info('Adding world_settings and global configuration columns to worlds table')

    await database.query(`
      ALTER TABLE worlds 
      ADD COLUMN IF NOT EXISTS world_settings JSON,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS thumbnail_hash VARCHAR;
    `)

    logger.info('world_settings columns added successfully')
  }
}

