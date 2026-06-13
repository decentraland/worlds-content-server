import { DeploymentRecord, IPartialDeploymentStore } from '../types'

export function createPartialDeploymentStore(): IPartialDeploymentStore {
  const records = new Map<string, DeploymentRecord>()

  return {
    async put(record: DeploymentRecord): Promise<void> {
      records.set(record.entityId, record)
    },

    async get(entityId: string): Promise<DeploymentRecord | undefined> {
      return records.get(entityId)
    },

    async markUploaded(entityId: string, fileHash: string): Promise<void> {
      const r = records.get(entityId)
      if (!r) throw new Error(`Deployment ${entityId} not found`)
      r.uploadedHashes.add(fileHash)
    },

    async delete(entityId: string): Promise<void> {
      records.delete(entityId)
    },

    async listExpiredBefore(timestamp: number): Promise<string[]> {
      const out: string[] = []
      for (const [entityId, r] of records) {
        if (r.expiresAt < timestamp) out.push(entityId)
      }
      return out
    },

    async clear(): Promise<void> {
      records.clear()
    }
  }
}
