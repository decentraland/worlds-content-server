import { Migration, MigratorComponents } from '../types'
import SQL from 'sql-template-strings'

const id = '0006_migrate_acls_to_permissions'

// Original permissions structure (before access was separated)
function legacyDefaultPermissions() {
  return {
    deployment: { type: 'allow-list', wallets: [] as string[] },
    access: { type: 'unrestricted' },
    streaming: { type: 'allow-list', wallets: [] as string[] }
  }
}

export const migration: Migration = {
  id,
  run: async (components: Pick<MigratorComponents, 'logs' | 'database'>) => {
    const logger = components.logs.getLogger(`migration-${id}`)

    const worlds = await components.database.query('SELECT name, acl FROM worlds ORDER BY name')
    for (const world of worlds.rows) {
      const worldName = world.name
      const permissions = legacyDefaultPermissions()
      if (world.acl) {
        permissions.deployment.wallets = JSON.parse(world.acl.slice(-1).pop()!.payload).allowed
        logger.info(`Migrating ACL for "${worldName}" to Permissions: ${JSON.stringify(permissions)}`)
      }
      await components.database.query(
        SQL`UPDATE worlds SET permissions = ${JSON.stringify(permissions)}::json WHERE name = ${worldName}`
      )
    }
  }
}
