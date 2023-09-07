import { MigratorComponents } from '../../types'
import { deepEqual, readFile, writeFile } from '../utils'
import { defaultPermissions } from '../../logic/permissions-checker'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'storage'>) => {
    const logger = components.logs.getLogger('migration-004')
    logger.info('running migration 004 - acl to permissions')

    for await (const key of components.storage.allFileIds('name-')) {
      const existing = await readFile(components.storage, key)
      if (existing) {
        const worldName = key.replace('name-', '')
        const permissions = existing.permissions || defaultPermissions()
        if (existing.acl) {
          permissions.deployment.wallets = JSON.parse(existing.acl.slice(-1).pop()!.payload).allowed
          delete existing.acl
        }

        const migrated = {
          ...existing,
          permissions
        }
        if (!deepEqual(existing, migrated)) {
          logger.info(`World "${worldName}" needs to be fixed: ${JSON.stringify(existing)}`)
          logger.info(`Writing "${key}" : ${JSON.stringify(migrated)}`)
          await writeFile(components.storage, key, migrated)
        }
      }
    }
  }
}
