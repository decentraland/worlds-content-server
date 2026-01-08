import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0016_add_spawn_coordinates_column',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0016')

    logger.info('Adding spawn_coordinates column, migrating data, and dropping deprecated columns (atomic transaction)')

    await database.query('BEGIN')

    try {
      // Step 1: Add spawn_coordinates column to worlds table
      logger.info('Adding spawn_coordinates column to worlds table')
      await database.query(`
        ALTER TABLE worlds 
        ADD COLUMN IF NOT EXISTS spawn_coordinates VARCHAR;
      `)

      // Step 2: Migrate spawn_coordinates from entity metadata (before dropping entity column)
      logger.info('Migrating spawn_coordinates from entity metadata')
      const migrateResult = await database.query(`
        UPDATE worlds
        SET 
          spawn_coordinates = COALESCE(
            entity->'metadata'->'scene'->>'base',
            entity->'metadata'->'scene'->'parcels'->>0
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
        `Successfully added spawn_coordinates column, updated ${migrateResult.rowCount} rows, ` +
          `and dropped deprecated columns (transaction committed)`
      )
    } catch (error: any) {
      await database.query('ROLLBACK')
      logger.error(`Migration failed, rolled back: ${error.message}`)
      throw error
    }
  }
}
