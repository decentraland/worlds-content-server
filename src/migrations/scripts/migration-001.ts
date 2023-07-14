import { MigratorComponents } from '../../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { stringToUtf8Bytes } from 'eth-connect'

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'storage'>) => {
    const logger = components.logs.getLogger('migration-001')
    logger.info('running migration 001')

    async function readFile(key: string): Promise<object | undefined> {
      const content = await components.storage.retrieve(key)
      if (!content) {
        return undefined
      }
      return JSON.parse((await streamToBuffer(await content.asStream())).toString())
    }

    async function writeFile(key: string, content: object) {
      logger.info(`Writing "${key}" : ${JSON.stringify(content)}`)
      await components.storage.storeStream(key, bufferToStream(stringToUtf8Bytes(JSON.stringify(content))))
    }

    // Fix incorrectly stored ACLs
    for await (const key of await components.storage.allFileIds('name-')) {
      if (key.startsWith('name-') && key.endsWith('.dcl.eth')) {
        if (key.toLowerCase() !== key) {
          logger.info(`Found "${key}" that needs to be fixed`)
          const existing = await readFile(key)
          const toBeModified = (await readFile(key.toLowerCase())) || {}
          logger.info(`Writing ${JSON.stringify({ existing, toBeModified })}`)
          await writeFile(key.toLowerCase(), {
            ...existing,
            ...toBeModified
          })
          await components.storage.delete([key])
        }
      }
    }
  }
}
