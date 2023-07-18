import { MigratorComponents, WorldMetadata } from '../../types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage/dist/content-item'
import { extractWorldRuntimeMetadata } from '../../logic/world-runtime-metadata-utils'
import { stringToUtf8Bytes } from 'eth-connect'

function deepEqual(a: any, b: any) {
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const count = [0, 0]
    for (const _key in a) count[0]++
    for (const _key in b) count[1]++
    if (count[0] - count[1] !== 0) {
      return false
    }
    for (const key in a) {
      if (!(key in b) || !deepEqual(a[key], b[key])) {
        return false
      }
    }
    for (const key in b) {
      if (!(key in a) || !deepEqual(b[key], a[key])) {
        return false
      }
    }
    return true
  } else {
    return a === b
  }
}

export default {
  run: async (components: Pick<MigratorComponents, 'logs' | 'storage'>) => {
    const logger = components.logs.getLogger('migration-002')
    logger.info('running migration 002')

    async function readFile(key: string): Promise<WorldMetadata | undefined> {
      const content = await components.storage.retrieve(key)
      if (!content) {
        return undefined
      }
      return JSON.parse((await streamToBuffer(await content.asStream())).toString()) as WorldMetadata
    }

    async function writeFile(key: string, content: object) {
      logger.info(`Writing "${key}" : ${JSON.stringify(content)}`)
      await components.storage.storeStream(key, bufferToStream(stringToUtf8Bytes(JSON.stringify(content))))
    }

    // Fix incorrectly stored ACLs
    for await (const key of await components.storage.allFileIds('name-')) {
      if (key.startsWith('name-')) {
        const existing = await readFile(key)
        if (existing) {
          const scene = (await readFile(existing.entityId)) as any
          const worldName = key.replace('name-', '')
          const runtimeMetadata = extractWorldRuntimeMetadata(worldName, { ...scene, id: existing.entityId })
          const migrated = {
            ...existing,
            runtimeMetadata: runtimeMetadata
          }
          if (!deepEqual(existing, migrated)) {
            logger.info(`World "${worldName}" needs to be fixed: ${JSON.stringify(existing)}`)
            await writeFile(key, migrated)
          }
        }
      }
    }
  }
}
