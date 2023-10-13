import { Migration, MigratorComponents } from '../types'

export const migration: Migration = {
  id: '0010_remove_world_metadata_files',
  run: async (components: Pick<MigratorComponents, 'logs' | 'database' | 'storage'>) => {
    const filesToDelete = []
    for await (const key of components.storage.allFileIds('name-')) {
      filesToDelete.push(key)
    }
    await components.storage.delete(filesToDelete)
  }
}
