import { Migration, MigratorComponents, PermissionType } from '../types'
import SQL from 'sql-template-strings'

export const migration: Migration = {
  id: '0019_migrate_permissions_to_world_permissions',
  async run(components: MigratorComponents) {
    const { database, logs } = components
    const logger = logs.getLogger('migration-0019')

    logger.info('Migrating existing permissions to world_permissions table')

    // Get all worlds with permissions
    const result = await database.query<{
      name: string
      permissions: {
        deployment?: { type: string; wallets?: string[] }
        streaming?: { type: string; wallets?: string[] }
      }
    }>('SELECT name, permissions FROM worlds WHERE permissions IS NOT NULL')

    let migrated = 0
    const now = new Date()

    for (const row of result.rows) {
      const worldName = row.name
      const permissions = row.permissions

      // Migrate deployment permissions
      if (
        permissions.deployment?.type === PermissionType.AllowList &&
        permissions.deployment.wallets?.length
      ) {
        for (const wallet of permissions.deployment.wallets) {
          await database.query(SQL`
            INSERT INTO world_permissions (world_name, permission_type, address, parcels, created_at, updated_at)
            VALUES (${worldName}, ${'deployment'}, ${wallet.toLowerCase()}, ${null}::text[], ${now}, ${now})
            ON CONFLICT (world_name, permission_type, address) DO NOTHING
          `)
          migrated++
        }
      }

      // Migrate streaming permissions
      if (
        permissions.streaming?.type === PermissionType.AllowList &&
        permissions.streaming.wallets?.length
      ) {
        for (const wallet of permissions.streaming.wallets) {
          await database.query(SQL`
            INSERT INTO world_permissions (world_name, permission_type, address, parcels, created_at, updated_at)
            VALUES (${worldName}, ${'streaming'}, ${wallet.toLowerCase()}, ${null}::text[], ${now}, ${now})
            ON CONFLICT (world_name, permission_type, address) DO NOTHING
          `)
          migrated++
        }
      }
    }

    logger.info(`Migrated ${migrated} permission entries to world_permissions table`)
  }
}

