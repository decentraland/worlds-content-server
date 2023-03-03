import type { IFetchComponent } from '@well-known-components/http-server'
import type {
  IBaseComponent,
  IConfigComponent,
  IHttpServerComponent,
  ILoggerComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { metricDeclarations } from './metrics'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { IStatusComponent } from './adapters/status'
import { AuthChain, Entity, EthAddress } from '@dcl/schemas'

export type GlobalContext = {
  components: BaseComponents
}

export type DeploymentToValidate = {
  entity: Entity
  files: Map<string, Uint8Array>
  authChain: AuthChain
  contentHashesInStorage: Map<string, boolean>
}

export type WorldMetadata = {
  entityId: string
  acl?: AuthChain
}

export type AccessControlList = {
  resource: string
  allowed: EthAddress[]
  timestamp: string
}

export interface Validator {
  validate(deployment: DeploymentToValidate): Promise<ValidationResult>
}

export type ValidationResult = {
  ok: () => boolean
  errors: string[]
}

export type ValidatorComponents = Pick<
  AppComponents,
  'config' | 'permissionChecker' | 'limitsManager' | 'storage' | 'worldsManager'
>

export type Validation = (
  components: ValidatorComponents,
  deployment: DeploymentToValidate
) => ValidationResult | Promise<ValidationResult>

export type IWorldNamePermissionChecker = {
  checkPermission(ethAddress: EthAddress, worldName: string): Promise<boolean>
  validate(deployment: DeploymentToValidate): Promise<boolean>
}

export type IDclNameChecker = {
  checkOwnership(ethAddress: EthAddress, worldName: string): Promise<boolean>
}

export type ContentStatus = {
  commitHash: string
  worldsCount: number
  details?: string[]
}

export type WorldStatus = { worldName: string; users: number }

export type CommsStatus = {
  adapterType: string
  statusUrl: string
  commitHash?: string
  users: number
  rooms: number
  details?: WorldStatus[]
}

export type StatusResponse = {
  content: ContentStatus
  comms: CommsStatus
}

export type ICommsAdapter = {
  connectionString(ethAddress: EthAddress, roomId: string): Promise<string>
  status(): Promise<CommsStatus>
}

export type ILimitsManager = {
  getAllowSdk6For(worldName: string): Promise<boolean>
  getMaxAllowedParcelsFor(worldName: string): Promise<number>
  getMaxAllowedSizeInMbFor(worldName: string): Promise<number>
}

export type IWorldsManager = {
  getDeployedWorldsNames(): Promise<string[]>
  getDeployedWorldsCount(): Promise<number>
  getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined>
  getEntityIdForWorld(worldName: string): Promise<string | undefined>
  getEntityForWorld(worldName: string): Promise<Entity | undefined>
  storeAcl(worldName: string, acl: AuthChain): Promise<void>
}

// components used in every environment
export type BaseComponents = {
  dclNameChecker: IDclNameChecker
  commsAdapter: ICommsAdapter
  config: IConfigComponent
  permissionChecker: IWorldNamePermissionChecker
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  storage: IContentStorageComponent
  limitsManager: ILimitsManager
  status: IStatusComponent
  sns: SnsComponent
  validator: Validator
  worldsManager: IWorldsManager
}

export type SnsComponent = { arn?: string }

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = any
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>
