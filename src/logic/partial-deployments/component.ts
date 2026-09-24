import { InvalidRequestError } from '@dcl/http-commons'
import { buildSceneDeploymentMessage } from '../utils'
import { FileInfo } from '@dcl/catalyst-storage'
import { AppComponents, DeploymentToValidate, MissingSceneReplacementAuthorizationError } from '../../types'
import { getPositiveInteger, mapWithConcurrency, raceWithSignal } from '../concurrency'
import { calculateDeploymentSizeFromFileInfos } from '../validations/scene'
import { FileReceipt } from '../../adapters/pending-scenes-manager/types'
import { IPartialDeploymentsComponent, StageDeploymentInput, StageDeploymentResult } from './types'

const ALREADY_DEPLOYED = 'Deployment failed: this entity is already deployed.'

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

/**
 * Stages authenticated, entity-keyed upload batches. The HTTP handler holds the shared content lock
 * and per-entity lock through this operation, including final publication. Receipts avoid storage
 * scans between initialization and final verification; reservations remain charged on write failure.
 * @param components Validation, persistence, storage and telemetry dependencies.
 * @returns Partial deployment orchestration.
 */
export async function createPartialDeploymentsComponent(
  components: Pick<
    AppComponents,
    | 'config'
    | 'coordinates'
    | 'entityDeployer'
    | 'limitsManager'
    | 'logs'
    | 'pendingScenesManager'
    | 'storage'
    | 'validator'
    | 'worldsManager'
    | 'deploymentProcessing'
    | 'metrics'
  >
): Promise<IPartialDeploymentsComponent> {
  const {
    config,
    coordinates,
    entityDeployer,
    limitsManager,
    pendingScenesManager,
    storage,
    validator,
    worldsManager,
    deploymentProcessing,
    metrics
  } = components
  const maxPendingPerDeployer = await getPositiveInteger(config, 'MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER', 10)

  async function metadata(hashes: string[], signal?: AbortSignal): Promise<Map<string, FileInfo | undefined>> {
    metrics.increment('partial_upload_metadata_checks', {}, hashes.length)
    return deploymentProcessing.trackStage('metadata', hashes.length, async () => {
      const infos = await mapWithConcurrency(
        hashes,
        deploymentProcessing.fileInfoConcurrency,
        (hash) => deploymentProcessing.trackWorker('metadata', () => storage.fileInfo(hash)),
        { signal, waitForActiveOnAbort: false }
      )
      return new Map(hashes.map((hash, index) => [hash, infos[index]]))
    })
  }

  async function stage(input: StageDeploymentInput): Promise<StageDeploymentResult> {
    const { baseUrl, entity, entityRaw, authChain, files, manifest, signal, deadlineAt } = input
    signal?.throwIfAborted()
    // Validation and publication see the manifest; accounting and storage only see uploaded files.
    const deploymentFiles = manifest ? new Map([...files, [entity.id, manifest]]) : files
    const pending = await pendingScenesManager.getByEntityId(entity.id, signal)
    const validation: DeploymentToValidate = {
      entity,
      files: deploymentFiles,
      authChain,
      contentHashesInStorage: new Map(),
      pendingCreatedAt: pending?.createdAt,
      signal
    }
    const stagingValidation = await validator.validateStaging(validation, {
      skipPermissionCheck: !!pending && pending.deployer === authChain[0]?.payload?.toLowerCase()
    })
    if (!stagingValidation.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${stagingValidation.errors.join(', ')}`)
    }

    // Only validated manifests may cause storage lookups or affect staging state.
    const contentHashes = Array.from(new Set((entity.content ?? []).map((content) => content.hash)))
    const worldName = entity.metadata.worldConfiguration.name.toLowerCase()
    const parcels = Array.from(new Set(coordinates.canonicalizeParcels(entity.pointers)))
    // A deployed entity is never staged again: its original signer already got the completion receipt,
    // and anyone else would only leave a reservation behind before failing at publication.
    if (await isDeployed(worldName, entity.id, signal)) {
      throw new InvalidRequestError(ALREADY_DEPLOYED)
    }
    if (!pending && (await raceWithSignal(worldsManager.hasNewerDeployedScene(worldName, entity), signal))) {
      throw new InvalidRequestError(
        'Deployment failed: a newer scene is already deployed on one or more of these parcels.'
      )
    }
    const maxSize = await raceWithSignal(limitsManager.getMaxAllowedSizeInBytesFor(worldName, parcels), signal)
    const initialInfos = pending?.initialized
      ? new Map<string, FileInfo | undefined>()
      : await metadata(contentHashes, signal)
    const receipts = new Map<string, FileReceipt>()
    for (const [hash, info] of initialInfos) {
      if (info?.size !== undefined && info.size !== null) receipts.set(hash, { hash, size: info.size, stored: true })
    }
    let incomingBytes = 0
    for (const [hash, file] of files) {
      incomingBytes += file.size
      receipts.set(hash, { hash, size: file.size, stored: receipts.get(hash)?.stored ?? false })
    }
    const knownSceneBytes = [...receipts.values()]
      .filter((receipt) => receipt.hash !== entity.id)
      .reduce((sum, receipt) => sum + BigInt(receipt.size), 0n)
    if (knownSceneBytes > maxSize) throw new InvalidRequestError('Deployment failed: The deployment is too big.')
    const pendingRow = await pendingScenesManager.upsert(
      { entityId: entity.id, worldName, parcels, entity, deployer: authChain[0].payload },
      { maxPendingPerDeployer },
      signal
    )
    try {
      await pendingScenesManager.reserve(entity.id, [...receipts.values()], maxSize, incomingBytes, signal)
    } catch (error) {
      // A first batch that isn't admitted must not keep its new upload holding a slot of the cap.
      if (!pending) await pendingScenesManager.discardUnadmitted(entity.id).catch(() => undefined)
      throw error
    }

    await deploymentProcessing.trackStage('storage', files.size, () =>
      mapWithConcurrency(
        Array.from(files),
        deploymentProcessing.storageConcurrency,
        ([hash, file]) =>
          deploymentProcessing.trackWorker('storage', () => storage.storeStream(hash, file.getStream(signal), signal)),
        // The content lock and temp files must outlive every started writer, including cancellation.
        { signal }
      )
    )
    await pendingScenesManager.recordStored(entity.id, [...files.keys()], true, signal)
    const progress = await pendingScenesManager.getProgress(entity.id, signal)
    const missing = contentHashes.filter((hash) => !progress.has(hash))
    metrics.increment('partial_upload_batches', { outcome: missing.length ? 'incomplete' : 'finalizing' })
    if (missing.length) return { complete: false, missing }

    // One full verification at completion. The shared content lock prevents GC from removing files
    // during this check, authorization, storage writes, or the publication transaction.
    const presentInfos = await metadata(contentHashes, signal)
    const nowMissing = contentHashes.filter((hash) => presentInfos.get(hash) === undefined)
    if (nowMissing.length) {
      await pendingScenesManager.markMissing(entity.id, nowMissing, signal)
      return { complete: false, missing: nowMissing }
    }
    const present = new Map(contentHashes.map((hash) => [hash, true]))
    const deployment: DeploymentToValidate = {
      entity,
      files: deploymentFiles,
      authChain,
      contentHashesInStorage: present,
      contentFileInfos: presentInfos,
      pendingCreatedAt: pendingRow.createdAt,
      signal
    }
    const fullValidation = await validator.validate(deployment)
    if (!fullValidation.ok()) throw new InvalidRequestError(`Deployment failed: ${fullValidation.errors.join(', ')}`)
    if (!deployment.sceneReplacementAuthorization) throw new MissingSceneReplacementAuthorizationError(entity.id)

    let result: Awaited<ReturnType<typeof entityDeployer.deployEntity>>
    try {
      result = await entityDeployer.deployEntity(
        baseUrl,
        entity,
        present,
        deploymentFiles,
        entityRaw,
        authChain,
        calculateDeploymentSizeFromFileInfos(entity, deploymentFiles, presentInfos),
        signal,
        deadlineAt,
        deployment.sceneReplacementAuthorization
      )
    } catch (error) {
      if (!isUniqueViolation(error) || !(await isDeployed(worldName, entity.id).catch(() => false))) {
        throw error
      }
      // Published concurrently: drop this request's staging state and answer like a completion retry.
      await pendingScenesManager.deleteByEntityId(entity.id).catch(() => undefined)
      const completed = await pendingScenesManager.getCompleted(entity.id, authChain[0].payload, signal)
      if (!completed) {
        throw new InvalidRequestError(ALREADY_DEPLOYED)
      }
      return {
        complete: true,
        creationTimestamp: completed.creationTimestamp,
        result: { message: buildSceneDeploymentMessage(baseUrl, completed.worldName, completed.parcels) }
      }
    }
    // Publication returns the same timestamp it atomically persists with the completion receipt.
    return { complete: true, result, creationTimestamp: result.creationTimestamp }
  }

  async function isDeployed(worldName: string, entityId: string, signal?: AbortSignal): Promise<boolean> {
    const { scenes } = await raceWithSignal(worldsManager.getWorldScenes({ worldName, entityId }, { limit: 1 }), signal)
    return scenes.length > 0
  }

  return { stage }
}
