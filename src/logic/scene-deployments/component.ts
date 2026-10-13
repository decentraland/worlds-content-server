import { InvalidRequestError } from '@dcl/http-commons'
import { Entity, EntityType } from '@dcl/schemas'
import { buildSceneDeploymentMessage, isPastExpiry } from '../utils'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import {
  AppComponents,
  DeploymentResult,
  DeploymentToValidate,
  DeploymentUniqueViolationError,
  MissingSceneReplacementAuthorizationError,
  WorldScene
} from '../../types'
import { mapWithConcurrency, raceWithSignal } from '../concurrency'
import { DEFAULT_CONTENT_FILE_INFO_CONCURRENCY } from '../deployment-processing'
import { calculateDeploymentSizeFromFileInfos } from '../validations/scene'
import { FileReceipt } from '../../adapters/pending-scenes-repository/types'
import { PartialUploadExpiredError, PendingScene } from '../partial-upload-admission'
import {
  DeployInput,
  DeployResult,
  ISceneDeploymentsComponent,
  PrevalidateDeploymentInput,
  PrevalidateStagingInput,
  StageDeploymentInput,
  StageDeploymentResult,
  StagingPrevalidation
} from './types'

/**
 * Fetches content metadata through a continuous bounded worker pool.
 *
 * @param storage Content storage used for metadata checks.
 * @param hashes Content hashes referenced by the deployment.
 * @param concurrency Maximum number of concurrent checks delegated to storage.
 * @param signal Optional deadline or request-disconnect signal.
 * @param trackWorker Optional worker telemetry wrapper.
 * @returns Storage metadata for every unique content hash.
 * @throws The cancellation reason without waiting for active metadata calls, which own no request files.
 */
export async function getContentFileInfos(
  storage: Pick<IContentStorageComponent, 'fileInfo'>,
  hashes: string[],
  concurrency: number = DEFAULT_CONTENT_FILE_INFO_CONCURRENCY,
  signal?: AbortSignal,
  trackWorker?: (operation: () => Promise<FileInfo | undefined>) => Promise<FileInfo | undefined>
): Promise<Map<string, FileInfo | undefined>> {
  const uniqueHashes = Array.from(new Set(hashes))
  const fileInfos = await mapWithConcurrency(
    uniqueHashes,
    concurrency,
    (hash) => (trackWorker ? trackWorker(() => storage.fileInfo(hash)) : storage.fileInfo(hash)),
    { signal, waitForActiveOnAbort: false }
  )
  return new Map(uniqueHashes.map((hash, index) => [hash, fileInfos[index]]))
}

/**
 * Lists the hashes of the entity's content.
 * @throws InvalidRequestError when the entity has no content list; pre-storage validation already rejects it.
 */
function getContentHashes(entity: Entity): string[] {
  if (!entity.content) throw new InvalidRequestError('Deployment failed: the entity has no content list.')
  return entity.content.map((content) => content.hash)
}

/**
 * Deploys scenes, in a single request or staged across authenticated, entity-keyed upload batches. The
 * HTTP handler holds the shared content lock (and, for batches, the per-entity lock) through deploy and
 * stage, including final publication. Storage is inventoried once, on the first batch; later batches and
 * publication rely on the upload's receipts. Reservations remain charged on write failure.
 * @param components Validation, persistence, storage and telemetry dependencies.
 * @returns Scene deployment orchestration.
 */
export async function createSceneDeploymentsComponent(
  components: Pick<
    AppComponents,
    | 'coordinates'
    | 'entityDeployer'
    | 'limitsManager'
    | 'logs'
    | 'partialUploadAdmission'
    | 'pendingScenesRepository'
    | 'storage'
    | 'uploadLimits'
    | 'validator'
    | 'worldsManager'
    | 'deploymentProcessing'
    | 'metrics'
  >
): Promise<ISceneDeploymentsComponent> {
  const {
    coordinates,
    entityDeployer,
    limitsManager,
    logs,
    partialUploadAdmission,
    pendingScenesRepository,
    storage,
    uploadLimits,
    validator,
    worldsManager,
    deploymentProcessing,
    metrics
  } = components
  const logger = logs.getLogger('deploy-entity')

  /** Storage metadata of every unique hash, tracked as the deployment's metadata stage. */
  async function fetchContentFileInfos(
    hashes: string[],
    signal?: AbortSignal
  ): Promise<Map<string, FileInfo | undefined>> {
    return deploymentProcessing.trackStage('metadata', new Set(hashes).size, () =>
      getContentFileInfos(storage, hashes, deploymentProcessing.fileInfoConcurrency, signal, (operation) =>
        deploymentProcessing.trackWorker('metadata', operation)
      )
    )
  }

  async function metadata(hashes: string[], signal?: AbortSignal): Promise<Map<string, FileInfo | undefined>> {
    metrics.increment('partial_upload_metadata_checks', {}, hashes.length)
    return fetchContentFileInfos(hashes, signal)
  }

  /** The live publication of an entity, optionally within a world. */
  async function findPublishedScene(
    entityId: string,
    options: { worldName?: string; signal?: AbortSignal } = {}
  ): Promise<WorldScene | undefined> {
    const { worldName, signal } = options
    return raceWithSignal(worldsManager.getDeployedScene(entityId, worldName), signal)
  }

  /**
   * Answers a publication that collided with an already deployed entity from its live publication, verified
   * against the database. When it can't be verified, the original database error propagates.
   */
  async function recoverAlreadyDeployed<T>(error: unknown, lookup: () => Promise<T | undefined>): Promise<T> {
    if (!(error instanceof DeploymentUniqueViolationError)) throw error
    // Best-effort: a lookup failure must not mask the original collision.
    const published = await lookup().catch(() => undefined)
    if (published === undefined) throw error.cause
    return published
  }

  async function prevalidateDeployment(input: PrevalidateDeploymentInput): Promise<DeploymentToValidate> {
    const { entity, authChain, files, signal } = input
    // Always validated against now, even while a partial upload of the same entity is pending, whose
    // staging state the publication then drops.
    const deployment: DeploymentToValidate = {
      entity,
      files,
      authChain,
      contentHashesInStorage: new Map<string, boolean>(),
      signal
    }
    const preStorageValidationResult = await validator.validateBeforeStorage(deployment)
    if (!preStorageValidationResult.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${preStorageValidationResult.errors.join(', ')}`)
    }
    return deployment
  }

  async function deploy(input: DeployInput): Promise<DeployResult> {
    const { baseUrl, entityFile, deployment, signal, deadlineAt } = input
    const { entity, files, authChain } = deployment
    signal.throwIfAborted()
    const contentHashes = getContentHashes(entity)
    const contentFileInfos = await fetchContentFileInfos(contentHashes, signal)
    const contentHashesInStorage = new Map(Array.from(contentFileInfos, ([hash, info]) => [hash, info !== undefined]))

    const validationResult = await validator.validateAfterStorage({
      ...deployment,
      contentHashesInStorage,
      contentFileInfos,
      signal
    })
    if (!validationResult.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${validationResult.errors.join(', ')}`)
    }
    if (entity.type === EntityType.SCENE && !deployment.sceneReplacementAuthorization) {
      throw new MissingSceneReplacementAuthorizationError(entity.id)
    }

    const deploymentSize = calculateDeploymentSizeFromFileInfos(entity, files, contentFileInfos)
    signal.throwIfAborted()
    let result: DeploymentResult
    try {
      result = await entityDeployer.deployEntity(
        baseUrl,
        entity,
        contentHashesInStorage,
        files,
        entityFile,
        authChain,
        deploymentSize,
        { signal, deadlineAt, sceneReplacementAuthorization: deployment.sceneReplacementAuthorization }
      )
    } catch (error) {
      // A concurrent duplicate (most commonly a client retry whose first attempt committed, or this
      // entity's partial finalize) won the publication: answer with an idempotent success.
      const { scene, worldName } = await recoverAlreadyDeployed(error, async () => {
        const worldName: string | undefined = entity.metadata?.worldConfiguration?.name?.toLowerCase()
        if (!worldName) return undefined
        const scene = await findPublishedScene(entity.id, { worldName })
        return scene && { scene, worldName }
      })
      logger.info('Deployment finalized concurrently; returning idempotent success', { entityId: entity.id, worldName })
      result = {
        // The live publication's timestamp, as the partial path answers.
        creationTimestamp: scene.createdAt.getTime(),
        message: buildSceneDeploymentMessage(
          baseUrl,
          entity.metadata?.worldConfiguration?.name ?? worldName,
          entity.metadata?.scene?.parcels || []
        )
      }
    }
    return { creationTimestamp: Date.now(), ...result }
  }

  async function validateStaging(
    input: PrevalidateStagingInput,
    pending: PendingScene | undefined,
    admittedAt: Date
  ): Promise<boolean> {
    const { entity, authChain, files, manifest, signal } = input
    // Validation sees the manifest; accounting and storage only see uploaded files.
    const deploymentFiles = manifest ? new Map([...files, [entity.id, manifest]]) : files
    const skipPermissionCheck = !!pending && pending.deployer === authChain[0]?.payload?.toLowerCase()
    const validation: DeploymentToValidate = {
      entity,
      files: deploymentFiles,
      authChain,
      contentHashesInStorage: new Map(),
      pendingCreatedAt: admittedAt,
      signal
    }
    const stagingValidation = await validator.validateStaging(validation, { skipPermissionCheck })
    if (!stagingValidation.ok()) {
      throw new InvalidRequestError(`Deployment failed: ${stagingValidation.errors.join(', ')}`)
    }
    return skipPermissionCheck
  }

  async function prevalidate(
    input: PrevalidateStagingInput,
    pending: PendingScene | undefined
  ): Promise<StagingPrevalidation> {
    input.signal?.throwIfAborted()
    const admittedAt = pending?.createdAt ?? new Date(input.requestArrivedAt)
    return { sawPending: await validateStaging(input, pending, admittedAt) }
  }

  async function stage(input: StageDeploymentInput): Promise<StageDeploymentResult> {
    const { baseUrl, entity, entityFile, authChain, files, manifest, signal, deadlineAt, requestArrivedAt } = input
    signal?.throwIfAborted()
    const deploymentFiles = manifest ? new Map([...files, [entity.id, manifest]]) : files
    const pending = await deploymentProcessing.trackStage('lookup', 1, () =>
      partialUploadAdmission.getByEntityId(entity.id, signal)
    )
    // Permission was skipped for the signer's own upload; only expiry cleanup removes it in between.
    if (input.prevalidation?.sawPending && !pending) throw new PartialUploadExpiredError()
    // One admission instant, the request's arrival, anchors both freshness and the upload's lifetime.
    const admittedAt = pending?.createdAt ?? new Date(requestArrivedAt)
    if (!input.prevalidation) await validateStaging(input, pending, admittedAt)

    // Only validated manifests may cause storage lookups or affect staging state.
    const contentHashes = Array.from(new Set(getContentHashes(entity)))
    const worldName = entity.metadata.worldConfiguration.name.toLowerCase()
    const parcels = Array.from(new Set(coordinates.canonicalizeParcels(entity.pointers)))
    const hasNewerScene =
      !pending &&
      (await deploymentProcessing.trackStage('lookup', 1, () =>
        raceWithSignal(worldsManager.hasNewerDeployedScene(worldName, entity), signal)
      ))
    if (hasNewerScene) {
      throw new InvalidRequestError(
        'Deployment failed: a newer scene is already deployed on one or more of these parcels.'
      )
    }
    const [maxSize, worldSceneCap] = await deploymentProcessing.trackStage('limits', 1, () =>
      raceWithSignal(
        Promise.all([
          limitsManager.getMaxAllowedSizeInBytesFor(worldName, parcels),
          limitsManager.getSceneSizeCapInBytesFor(worldName)
        ]),
        signal
      )
    )
    const initialInfos = pending?.initialized
      ? new Map<string, FileInfo | undefined>()
      : await metadata(contentHashes, signal)
    const inStorage = [...initialInfos].flatMap(([hash, info]) =>
      info?.size !== undefined && info.size !== null ? [{ hash, size: info.size }] : []
    )
    // Stored content is free only when published content keeps it; if only pending uploads hold it, it's charged.
    const published = await deploymentProcessing.trackStage('admission', 1, () =>
      pendingScenesRepository.getPublishedContent(
        inStorage.map(({ hash }) => hash),
        signal
      )
    )
    const receipts = new Map<string, FileReceipt>()
    for (const { hash, size } of inStorage) {
      receipts.set(hash, { hash, size, stored: true, charged: !published.has(hash) })
    }
    // Files already present, before the upload or from an earlier batch, are dropped; their receipt keeps its charge.
    const stored = pending
      ? await deploymentProcessing.trackStage('admission', 1, () =>
          pendingScenesRepository.getProgress(entity.id, signal)
        )
      : new Map<string, number>()
    const toStore = new Map([...files].filter(([hash]) => !stored.has(hash) && !receipts.has(hash)))
    let incomingBytes = 0
    for (const file of files.values()) incomingBytes += file.size
    for (const [hash, file] of toStore) receipts.set(hash, { hash, size: file.size, stored: false, charged: true })
    const knownSceneBytes = [...receipts.values()]
      .filter((receipt) => receipt.hash !== entity.id)
      .reduce((sum, receipt) => sum + BigInt(receipt.size), 0n)
    if (knownSceneBytes > maxSize) throw new InvalidRequestError('Deployment failed: The deployment is too big.')
    const pendingRow = await deploymentProcessing.trackStage('admission', 1, () =>
      partialUploadAdmission.admitBatch(
        {
          upload: {
            entityId: entity.id,
            worldName,
            parcels,
            entity,
            deployer: authChain[0].payload,
            admittedAt,
            resumes: !!pending
          },
          receipts: [...receipts.values()],
          maxSceneBytes: maxSize,
          // The two limits reads may see different whitelists; never budget the world below this scene's cap.
          worldSceneCapBytes: worldSceneCap > maxSize ? worldSceneCap : maxSize,
          incomingBytes
        },
        signal
      )
    )
    if (!pending) metrics.increment('partial_uploads_started')

    // Re-checked right before storing on this instance's clock; GC and publication use the database's.
    if (isPastExpiry(pendingRow.expiresAt)) {
      throw new PartialUploadExpiredError()
    }
    await deploymentProcessing.trackStage('storage', toStore.size, () =>
      mapWithConcurrency(
        Array.from(toStore),
        deploymentProcessing.storageConcurrency,
        ([hash, file]) =>
          deploymentProcessing.trackWorker('storage', () => storage.storeStream(hash, file.getStream(signal), signal)),
        // The content lock and temp files must outlive every started writer, including cancellation.
        { signal }
      )
    )
    const batches = await deploymentProcessing.trackStage('admission', 1, () =>
      partialUploadAdmission.recordStored(entity.id, [...toStore.keys()], signal)
    )
    const progress = await deploymentProcessing.trackStage('admission', 1, () =>
      pendingScenesRepository.getProgress(entity.id, signal)
    )
    const missing = contentHashes.filter((hash) => !progress.has(hash))
    metrics.increment('partial_upload_batches', { outcome: missing.length ? 'incomplete' : 'finalizing' })
    if (missing.length) return { complete: false, missing }

    // Progress holds every hash's size once none is missing; GC keeps a live upload's content and can't
    // run under the content lock held through publication, so storage isn't probed again.
    const sizes = new Map(Array.from(progress, ([hash, size]) => [hash, { size }]))
    const present = new Map(contentHashes.map((hash) => [hash, true]))
    const deployment: DeploymentToValidate = {
      entity,
      files: deploymentFiles,
      authChain,
      contentHashesInStorage: present,
      contentFileInfos: sizes,
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
        entityFile,
        authChain,
        calculateDeploymentSizeFromFileInfos(entity, deploymentFiles, sizes),
        {
          signal,
          deadlineAt,
          sceneReplacementAuthorization: deployment.sceneReplacementAuthorization,
          completesPartialUpload: { ttlMs: uploadLimits.pendingDeploymentTtlMs },
          // A batch of this upload stored it; its id is the hash of these bytes.
          storedEntityFile: progress.has(entity.id)
        }
      )
    } catch (error) {
      const concurrent = await recoverAlreadyDeployed(error, () => findPublication(baseUrl, entity.id))
      // Published concurrently: drop this request's staging state and answer with the live publication.
      await pendingScenesRepository.deleteByEntityId(entity.id).catch(() => undefined)
      return concurrent
    }
    metrics.increment('partial_uploads_completed')
    metrics.observe('partial_upload_duration_seconds', {}, (Date.now() - pendingRow.createdAt.getTime()) / 1000)
    metrics.observe('partial_upload_batches_per_upload', {}, batches)
    // Publication returns the same timestamp it atomically persists with the completion receipt.
    return { complete: true, result, creationTimestamp: result.creationTimestamp }
  }

  async function findPublication(
    baseUrl: string,
    entityId: string,
    signal?: AbortSignal
  ): Promise<StageDeploymentResult | undefined> {
    const scene = await findPublishedScene(entityId, { signal })
    if (!scene) return undefined
    return {
      complete: true,
      creationTimestamp: scene.createdAt.getTime(),
      result: {
        message: buildSceneDeploymentMessage(
          baseUrl,
          scene.entity.metadata?.worldConfiguration?.name ?? scene.worldName,
          scene.entity.metadata?.scene?.parcels ?? scene.parcels
        )
      }
    }
  }

  return { prevalidateDeployment, deploy, stage, prevalidate, findPublication }
}
