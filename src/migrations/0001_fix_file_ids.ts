import { Migration, MigratorComponents } from '../types'
import { readFile, writeFile } from '../logic/utils'

const id = '0001_fix_file_ids'

export const migration: Migration = {
  id,
  run: async (components: Pick<MigratorComponents, 'logs' | 'storage'>) => {
    const logger = components.logs.getLogger(`migration-${id}`)

    // Fix incorrectly stored ACLs
    for await (const key of components.storage.allFileIds('name-')) {
      if (key.startsWith('name-') && key.endsWith('.dcl.eth')) {
        if (key.toLowerCase() !== key) {
          logger.info(`Found "${key}" that needs to be fixed`)
          const existing = await readFile(components.storage, key)
          const toBeModified = (await readFile(components.storage, key.toLowerCase())) || {}
          logger.info(`Writing ${JSON.stringify({ existing, toBeModified })}`)
          await writeFile(components.storage, key.toLowerCase(), {
            ...existing,
            ...toBeModified
          })
          await components.storage.delete([key])
        }
      }
    }
  }
}
