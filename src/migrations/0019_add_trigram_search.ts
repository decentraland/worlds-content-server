import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0019_add_trigram_search',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0019')

    logger.info('Enabling pg_trgm extension and creating trigram indexes for fuzzy search')

    // This migration requires the pg_trgm extension to be enabled. The installation is not done in the
    // migration due to the fact that it requires the user to have superuser privileges.

    await database.query(`
      -- Create GIN indexes for trigram search on name, title, and description
      -- These indexes support ILIKE, similarity(), and other trigram operations
      CREATE INDEX IF NOT EXISTS worlds_name_trgm_idx ON worlds USING GIN(name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS worlds_title_trgm_idx ON worlds USING GIN(title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS worlds_description_trgm_idx ON worlds USING GIN(description gin_trgm_ops);
    `)

    logger.info('Successfully enabled pg_trgm and created trigram indexes')
  }
}
