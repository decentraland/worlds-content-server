import { MigratorComponents } from '../../types'
import { defaultPermissions } from '../../logic/permissions-checker'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'database' | 'worldsManager'>) => {
    const logger = components.logs.getLogger('migration-004')
    logger.info('running migration 004 - acl to permissions')

    const worlds = await components.database.query('SELECT name, acl FROM worlds ORDER BY name')
    for (const world of worlds.rows) {
      const worldName = world.name
      const permissions = defaultPermissions()
      if (world.acl) {
        permissions.deployment.wallets = JSON.parse(world.acl.slice(-1).pop()!.payload).allowed
        logger.info(`Migrating ACL for "${worldName}" to Permissions: ${JSON.stringify(permissions)}`)
        await components.worldsManager.storePermissions(worldName, permissions)
      }
    }
  }
}
