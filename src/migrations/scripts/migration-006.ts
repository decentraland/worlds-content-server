import { MigratorComponents } from '../../types'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'database' | 'storage'>) => {
    const logger = components.logs.getLogger('migration-006')
    logger.info('running migration 006 - remove world metadata files')

    // Fix incorrectly stored ACLs
    const filesToDelete = []
    for await (const key of components.storage.allFileIds('name-')) {
      filesToDelete.push(key)
    }
    await components.storage.delete(filesToDelete)
  }
}
