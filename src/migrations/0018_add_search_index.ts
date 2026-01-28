import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0018_add_search_index',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0018')

    logger.info('Adding full-text search vector column and index to worlds table')

    await database.query(`
      -- Add search vector column as a generated column
      -- Weights: A (highest) for name, B for title, C for description
      ALTER TABLE worlds 
        ADD COLUMN IF NOT EXISTS search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(title, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'C')
        ) STORED;

      -- Create GIN index for efficient full-text search
      CREATE INDEX IF NOT EXISTS worlds_search_idx ON worlds USING GIN(search_vector);
    `)

    logger.info('Successfully added full-text search index to worlds table')
  }
}
