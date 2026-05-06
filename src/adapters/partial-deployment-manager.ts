import { Entity } from '@dcl/schemas'
import { randomBytes } from 'crypto'
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

export function createPartialDeploymentManager(
  components: ManagerComponents,
  mutex: Mutex
): IPartialDeploymentManager {
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

  function recomputeMissing(
    manifest: Record<string, number>,
    uploaded: Set<string>,
    available: Set<string>
  ): string[] {
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
      logger.info('Init partial deployment', { entityId: input.entityId, missing: missing.length, available: alreadyAvailable.size })

      return {
        availableFiles: Array.from(alreadyAvailable),
        missingFiles: missing,
        deploymentToken: record.deploymentToken,
        expiresAt: record.expiresAt
      }
    })
  }

  async function addFile(_e: string, _h: string, _t: string, _b: Buffer): Promise<void> {
    throw new Error('not implemented yet')
  }

  async function complete(_b: string, _e: string, _t: string): Promise<DeploymentResult> {
    throw new Error('not implemented yet')
  }

  async function status(_e: string): Promise<PartialDeploymentStatus | undefined> {
    throw new Error('not implemented yet')
  }

  return { init, addFile, complete, status }
}
