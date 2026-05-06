import { bufferToStream, IContentStorageComponent, streamToBuffer } from '@dcl/catalyst-storage'
import { IPartialDeploymentTempStorage } from '../types'

const TEMP_PREFIX = 'temp/partial'

function entityRawKey(entityId: string): string {
  return `${TEMP_PREFIX}/${entityId}/.entity`
}

function fileKey(entityId: string, fileHash: string): string {
  return `${TEMP_PREFIX}/${entityId}/${fileHash}`
}

export function createPartialDeploymentTempStorage(
  components: { storage: IContentStorageComponent }
): IPartialDeploymentTempStorage {
  const { storage } = components

  return {
    async putEntityRaw(entityId, bytes) {
      await storage.storeStream(entityRawKey(entityId), bufferToStream(bytes))
    },

    async putFile(entityId, fileHash, bytes) {
      await storage.storeStream(fileKey(entityId, fileHash), bufferToStream(bytes))
    },

    async getEntityRaw(entityId) {
      const item = await storage.retrieve(entityRawKey(entityId))
      if (!item) throw new Error(`Temp entity-raw not found: ${entityId}`)
      return streamToBuffer(await item.asStream())
    },

    async getFile(entityId, fileHash) {
      const item = await storage.retrieve(fileKey(entityId, fileHash))
      if (!item) throw new Error(`Temp file not found: ${entityId}/${fileHash}`)
      return streamToBuffer(await item.asStream())
    },

    async deleteAll(entityId) {
      // Best-effort: delete the entity-raw key. Per-file blobs are deleted by
      // the manager (which knows the manifest hashes) via storage.delete([keys]).
      const item = await storage.retrieve(entityRawKey(entityId))
      if (item) {
        await storage.delete([entityRawKey(entityId)])
      }
    }
  }
}
