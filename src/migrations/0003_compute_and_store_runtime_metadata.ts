import { Migration, MigratorComponents } from '../types'
import { extractWorldRuntimeMetadata } from '../logic/world-runtime-metadata-utils'
import { deepEqual, readFile, writeFile } from '../logic/utils'

const id = '0003_compute_and_store_runtime_metadata'

export const migration: Migration = {
  id,
  run: async (components: Pick<MigratorComponents, 'logs' | 'storage'>) => {
    const logger = components.logs.getLogger(`migration-${id}`)

    // Fix incorrectly stored ACLs
    for await (const key of components.storage.allFileIds('name-')) {
      if (key.startsWith('name-')) {
        const existing = await readFile(components.storage, key)
        if (existing) {
          const scene = (await readFile(components.storage, existing.entityId)) as any
          const worldName = key.replace('name-', '')
          const runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...scene, id: existing.entityId })
          const migrated = {
            ...existing,
            runtimeMetadata: runtimeMetadata
          }
          if (!deepEqual(existing, migrated)) {
            logger.info(`World "${worldName}" needs to be fixed: ${JSON.stringify(existing)}`)
            await writeFile(components.storage, key, migrated)
          }
        }
      }
    }
  }
}
