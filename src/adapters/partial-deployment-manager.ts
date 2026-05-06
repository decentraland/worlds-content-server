import { Entity } from '@dcl/schemas'
import { randomBytes } from 'crypto'
import { hashV1 } from '@dcl/hashing'
import { InvalidRequestError } from '@dcl/http-commons'
import {
  AppComponents,
  DeploymentRecord,
  DeploymentResult,
  IPartialDeploymentManager,
  PARTIAL_DEPLOYMENT_TTL_MS,
  PartialDeploymentInitInput,
  PartialDeploymentInitResult,
  PartialDeploymentStatus
} from '../types'
import { Mutex } from './partial-deployment-mutex'

type ManagerComponents = Pick<
  AppComponents,
  | 'storage'
  | 'partialDeploymentStore'
  | 'partialDeploymentTempStorage'
  | 'partialDeploymentValidator'
  | 'entityDeployer'
  | 'logs'
>

export function createPartialDeploymentManager(components: ManagerComponents, mutex: Mutex): IPartialDeploymentManager {
  const {
    storage,
    partialDeploymentStore: store,
    partialDeploymentTempStorage: tempStorage,
    partialDeploymentValidator: validator,
    logs
  } = components
  const logger = logs.getLogger('partial-deployment-manager')

  function newToken(): string {
    return randomBytes(32).toString('hex')
  }

  function recomputeMissing(manifest: Record<string, number>, uploaded: Set<string>, available: Set<string>): string[] {
    const out: string[] = []
    for (const h of Object.keys(manifest)) {
      if (!uploaded.has(h) && !available.has(h)) out.push(h)
    }
    return out
  }

  async function init(input: PartialDeploymentInitInput): Promise<PartialDeploymentInitResult> {
    return mutex.run(input.entityId, async () => {
      const existing = await store.get(input.entityId)
      if (existing) {
        if (existing.ownerAddress.toLowerCase() !== input.ownerAddress.toLowerCase()) {
          throw new InvalidRequestError(
            `Deployment ${input.entityId} owner mismatch: cannot re-init from a different wallet`
          )
        }
        return {
          availableFiles: Array.from(existing.alreadyAvailableHashes),
          missingFiles: recomputeMissing(existing.manifest, existing.uploadedHashes, existing.alreadyAvailableHashes),
          deploymentToken: existing.deploymentToken,
          expiresAt: existing.expiresAt
        }
      }

      const entityMetadata = JSON.parse(input.entityRaw.toString())
      const entity: Entity = { id: input.entityId, timestamp: Date.now(), ...entityMetadata }
      const contentHashesInStorage = await storage.existMultiple(
        Array.from(new Set(entity.content?.map(($) => $.hash) ?? []))
      )

      const preflight = await validator.preflight({
        entity,
        authChain: input.authChain,
        fileSizesManifest: input.manifest,
        contentHashesInStorage
      })
      if (!preflight.ok()) {
        throw new InvalidRequestError(`Init validation failed: ${preflight.errors.join(', ')}`)
      }

      const allHashes = Object.keys(input.manifest)
      const availability = await storage.existMultiple(allHashes)
      const alreadyAvailable = new Set<string>()
      const missing: string[] = []
      for (const h of allHashes) {
        if (availability.get(h)) alreadyAvailable.add(h)
        else missing.push(h)
      }

      const record: DeploymentRecord = {
        entityId: input.entityId,
        authChain: input.authChain,
        ownerAddress: input.ownerAddress,
        manifest: input.manifest,
        uploadedHashes: new Set(),
        alreadyAvailableHashes: alreadyAvailable,
        deploymentToken: newToken(),
        expiresAt: Date.now() + PARTIAL_DEPLOYMENT_TTL_MS
      }

      await store.put(record)
      await tempStorage.putEntityRaw(input.entityId, input.entityRaw)
      logger.info('Init partial deployment', {
        entityId: input.entityId,
        missing: missing.length,
        available: alreadyAvailable.size
      })

      return {
        availableFiles: Array.from(alreadyAvailable),
        missingFiles: missing,
        deploymentToken: record.deploymentToken,
        expiresAt: record.expiresAt
      }
    })
  }

  async function addFile(entityId: string, fileHash: string, token: string, bytes: Buffer): Promise<void> {
    return mutex.run(entityId, async () => {
      const record = await store.get(entityId)
      if (!record) {
        throw new InvalidRequestError(`Deployment ${entityId} not found`)
      }
      if (record.expiresAt < Date.now()) {
        await tempStorage.deleteAll(entityId).catch(() => undefined)
        await store.delete(entityId)
        throw new InvalidRequestError(`Deployment ${entityId} expired`)
      }
      if (record.deploymentToken !== token) {
        throw new InvalidRequestError(`Deployment ${entityId} token mismatch`)
      }

      const computed = await hashV1(bytes)
      if (computed !== fileHash) {
        throw new InvalidRequestError(`File hash mismatch: path=${fileHash} computed=${computed}`)
      }
      if (!(fileHash in record.manifest)) {
        throw new InvalidRequestError(`File ${fileHash} not in manifest for deployment ${entityId} (unexpected file)`)
      }
      if (record.manifest[fileHash] !== bytes.length) {
        throw new InvalidRequestError(
          `File ${fileHash} size mismatch: declared=${record.manifest[fileHash]} actual=${bytes.length}`
        )
      }

      await tempStorage.putFile(entityId, fileHash, bytes)
      await store.markUploaded(entityId, fileHash)
    })
  }

  async function deleteAll(record: DeploymentRecord): Promise<void> {
    const fileKeys = Object.keys(record.manifest).map((h) => `temp/partial/${record.entityId}/${h}`)
    if (fileKeys.length > 0) {
      await storage.delete(fileKeys).catch(() => undefined)
    }
    await tempStorage.deleteAll(record.entityId).catch(() => undefined)
    await store.delete(record.entityId)
  }

  async function complete(baseUrl: string, entityId: string, token: string): Promise<DeploymentResult> {
    return mutex.run(entityId, async () => {
      const record = await store.get(entityId)
      if (!record) {
        throw new InvalidRequestError(`Deployment ${entityId} not found`)
      }
      if (record.expiresAt < Date.now()) {
        await deleteAll(record)
        throw new InvalidRequestError(`Deployment ${entityId} expired`)
      }
      if (record.deploymentToken !== token) {
        throw new InvalidRequestError(`Deployment ${entityId} token mismatch`)
      }

      const entityRaw = await tempStorage.getEntityRaw(entityId)
      const entityMetadataJson = JSON.parse(entityRaw.toString())
      const entity: Entity = { id: entityId, timestamp: Date.now(), ...entityMetadataJson }
      const expectedHashes = new Set(entity.content?.map(($) => $.hash) ?? [])

      const uploadedFiles = new Map<string, Uint8Array>()
      for (const h of expectedHashes) {
        if (record.uploadedHashes.has(h)) {
          uploadedFiles.set(h, await tempStorage.getFile(entityId, h))
        }
      }

      const contentHashesInStorage = await storage.existMultiple(Array.from(expectedHashes))

      const validation = await validator.final({
        entity,
        files: uploadedFiles,
        authChain: record.authChain,
        contentHashesInStorage
      })
      if (!validation.ok()) {
        throw new InvalidRequestError(`Deployment failed: ${validation.errors.join(', ')}`)
      }

      try {
        return await components.entityDeployer.deployEntity(
          baseUrl,
          entity,
          contentHashesInStorage,
          uploadedFiles,
          entityRaw.toString(),
          record.authChain
        )
      } finally {
        await deleteAll(record).catch((err) => logger.warn('cleanup failed', { err: String(err) }))
      }
    })
  }

  async function status(entityId: string): Promise<PartialDeploymentStatus | undefined> {
    const record = await store.get(entityId)
    if (!record) return undefined
    if (record.expiresAt < Date.now()) {
      await deleteAll(record).catch(() => undefined)
      return undefined
    }
    return {
      availableFiles: [...record.alreadyAvailableHashes, ...record.uploadedHashes],
      missingFiles: Object.keys(record.manifest).filter(
        (h) => !record.uploadedHashes.has(h) && !record.alreadyAvailableHashes.has(h)
      ),
      expiresAt: record.expiresAt
    }
  }

  return { init, addFile, complete, status }
}
