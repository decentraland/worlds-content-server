import { AuthChain, Entity } from '@dcl/schemas'
// Type-only import: DeploymentFile/DeploymentResult are shared types in the central types module, which
// in turn references IPartialDeploymentsComponent for AppComponents — keeping this import type-only
// erases the edge so there is no runtime import cycle.
import type { DeploymentFile, DeploymentResult } from '../../types'

export type StageDeploymentInput = {
  baseUrl: string
  entity: Entity
  entityRaw: string
  authChain: AuthChain
  files: Map<string, DeploymentFile>
}

export type StageDeploymentResult = {
  /** Whether this request completed the content set and the scene was deployed. */
  complete: boolean
  /** Content hashes still missing (present when `complete` is false). */
  missing?: string[]
  /** The deployment result (present when `complete` is true). */
  result?: DeploymentResult
}

export type IPartialDeploymentsComponent = {
  /**
   * Stages one request of a partial scene deployment: validates everything that doesn't need the full
   * content set, stores the uploaded files, records/refreshes the pending scene, and — when this
   * request completes the content set — runs the full validation + deploy and returns the result.
   * Throws `InvalidRequestError` (HTTP 400) on client errors.
   */
  stage(input: StageDeploymentInput): Promise<StageDeploymentResult>
}
