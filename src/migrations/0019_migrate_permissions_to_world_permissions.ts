import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0019_migrate_permissions_to_world_permissions',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0019')

    logger.info('Migrating existing permissions to world_permissions table')

    // Migrate deployment permissions using a single INSERT from JSON data
    // Cast permissions to jsonb to handle both json and jsonb column types
    const deploymentResult = await database.query(`
      INSERT INTO world_permissions (world_name, permission_type, address, created_at, updated_at)
      SELECT 
        w.name,
        'deployment',
        LOWER(wallet),
        NOW(),
        NOW()
      FROM worlds w,
        jsonb_array_elements_text((w.permissions::jsonb)->'deployment'->'wallets') AS wallet
      WHERE w.permissions IS NOT NULL
        AND (w.permissions::jsonb)->'deployment'->>'type' = 'allow-list'
        AND jsonb_array_length(COALESCE((w.permissions::jsonb)->'deployment'->'wallets', '[]'::jsonb)) > 0
      ON CONFLICT (world_name, permission_type, address) DO NOTHING
    `)

    // Migrate streaming permissions using a single INSERT from JSON data
    const streamingResult = await database.query(`
      INSERT INTO world_permissions (world_name, permission_type, address, created_at, updated_at)
      SELECT 
        w.name,
        'streaming',
        LOWER(wallet),
        NOW(),
        NOW()
      FROM worlds w,
        jsonb_array_elements_text((w.permissions::jsonb)->'streaming'->'wallets') AS wallet
      WHERE w.permissions IS NOT NULL
        AND (w.permissions::jsonb)->'streaming'->>'type' = 'allow-list'
        AND jsonb_array_length(COALESCE((w.permissions::jsonb)->'streaming'->'wallets', '[]'::jsonb)) > 0
      ON CONFLICT (world_name, permission_type, address) DO NOTHING
    `)

    const totalMigrated = (deploymentResult.rowCount || 0) + (streamingResult.rowCount || 0)
    logger.info(`Migrated ${totalMigrated} permission entries to world_permissions table`)

    // Add the new 'access' column for access control settings
    logger.info('Creating access column and migrating access settings')
    await database.query(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS access JSONB`)

    // Copy the access part from permissions to the new access column
    // Default to unrestricted if no access setting exists
    await database.query(`
      UPDATE worlds
      SET access = COALESCE((permissions::jsonb)->'access', '{"type": "unrestricted"}'::jsonb)
      WHERE permissions IS NOT NULL
    `)

    // Set default access for worlds without permissions
    await database.query(`
      UPDATE worlds
      SET access = '{"type": "unrestricted"}'::jsonb
      WHERE access IS NULL
    `)

    // Drop the old permissions column
    await database.query(`ALTER TABLE worlds DROP COLUMN IF EXISTS permissions`)

    logger.info('Successfully migrated permissions to access column and world_permissions table')
  }
}
