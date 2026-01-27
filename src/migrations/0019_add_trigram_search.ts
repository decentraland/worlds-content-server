import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0019_add_trigram_search',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0019')

    logger.info('Attempting to enable pg_trgm extension for fuzzy search')

    // Check if pg_trgm extension is already installed
    const extensionCheck = await database.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
      ) as installed
    `)

    const isExtensionInstalled = extensionCheck.rows[0]?.installed ?? false

    if (isExtensionInstalled) {
      logger.info('pg_trgm extension is already installed, creating indexes')
    } else {
      // Try to create the extension (requires superuser privileges)
      try {
        await database.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
        logger.info('Successfully created pg_trgm extension')
      } catch (error) {
        logger.warn(
          'Could not create pg_trgm extension (requires superuser privileges). ' +
            'Trigram-based fuzzy search will not be available. ' +
            'To enable it, run "CREATE EXTENSION pg_trgm;" as a superuser. ' +
            'The search will still work using full-text search and ILIKE patterns.'
        )
        return
      }
    }

    // Create GIN indexes for trigram search on name, title, and description
    // These indexes support ILIKE, similarity(), and other trigram operations
    await database.query(`
      CREATE INDEX IF NOT EXISTS worlds_name_trgm_idx ON worlds USING GIN(name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS worlds_title_trgm_idx ON worlds USING GIN(title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS worlds_description_trgm_idx ON worlds USING GIN(description gin_trgm_ops);
    `)

    logger.info('Successfully created trigram indexes for fuzzy search')
  }
}
