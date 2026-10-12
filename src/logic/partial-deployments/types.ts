import { AuthChain, Entity } from '@dcl/schemas'
// Type-only import: DeploymentFile/DeploymentResult are shared types in the central types module, which
// in turn references IPartialDeploymentsComponent for AppComponents — keeping this import type-only
// erases the edge so there is no runtime import cycle.
import type { DeploymentFile, DeploymentResult } from '../../types'
import type { PendingScene } from '../../adapters/pending-scenes-manager/types'

export type StageDeploymentInput = {
  baseUrl: string
  entity: Entity
  entityRaw: string
  authChain: AuthChain
  /** Files uploaded in this request; those not already present are charged, stored and recorded. */
  files: Map<string, DeploymentFile>
  /** The entity file read back from storage when this request didn't upload it. Validated, never charged. */
  manifest?: DeploymentFile
  /**
   * Request-scoped cancellation (client disconnect or the deployment-processing deadline). Bounds this
   * staging request's validation, hashing, file storing, and — when it finalizes — the deploy itself.
   * The pending row survives cancellation, so the client simply resumes.
   */
  signal?: AbortSignal
  /** Absolute processing deadline forwarded to the deploy transaction when this request finalizes. */
  deadlineAt?: number
  /** When the request arrived, before its body was read; admits a new upload at that instant. */
  requestArrivedAt: number
  /** Set when the batch was validated before the content lock; staging then skips its validation. */
  prevalidation?: StagingPrevalidation
}

/** The parts of a staging request its validation needs; none of them requires the content lock. */
export type PrevalidateStagingInput = Pick<
  StageDeploymentInput,
  'entity' | 'authChain' | 'files' | 'manifest' | 'signal' | 'requestArrivedAt'
>

export type StagingPrevalidation = {
  /** A live upload of this signer was seen, so the permission check was skipped; staging requires it to remain. */
  sawPending: boolean
}

export type StageDeploymentResult = {
  /** Whether this request completed the content set and the scene was deployed. */
  complete: boolean
  /** Original commit timestamp, stable across completion retries. */
  creationTimestamp?: number
  /** Content hashes still missing (present when `complete` is false). */
  missing?: string[]
  /** The deployment result (present when `complete` is true). */
  result?: DeploymentResult
}

export type IPartialDeploymentsComponent = {
  /**
   * Stages one request of a partial scene deployment: validates everything that doesn't need the full
   * content set (unless `prevalidation` says it already did), stores the uploaded files, records/refreshes
   * the pending scene, and — when this request completes the content set — runs the full validation +
   * deploy and returns the result. Throws `InvalidRequestError` (HTTP 400) on client errors, including
   * `PartialUploadExpiredError` when the upload `prevalidation` saw is gone, and
   * `PartialUploadQuotaExceededError` (HTTP 429) when a partial-upload quota is full.
   */
  stage(input: StageDeploymentInput): Promise<StageDeploymentResult>
  /**
   * Runs the staging validation of {@link IPartialDeploymentsComponent.stage} ahead of it, anchored on a
   * pending upload read beforehand. Hashes the uploaded files and checks permission unless `pending` is
   * the signer's own upload. Throws `InvalidRequestError` (HTTP 400) when the batch is invalid.
   */
  prevalidate(input: PrevalidateStagingInput, pending: PendingScene | undefined): Promise<StagingPrevalidation>
  /**
   * Returns the live publication of an entity as a completed result, or undefined when it isn't
   * published. The entity id is the entity file's hash, so the live entity is exactly what any
   * uploader of that id asked for; callers answer every partial batch for it with this result.
   */
  findPublication(baseUrl: string, entityId: string, signal?: AbortSignal): Promise<StageDeploymentResult | undefined>
}
