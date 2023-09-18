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
import { HTTPProvider } from 'eth-connect'
import { ISubgraphComponent } from '@well-known-components/thegraph-component'
import { IStatusComponent } from './adapters/status'
import { AuthChain, AuthLink, Entity, EthAddress, IPFSv2 } from '@dcl/schemas'
import { MigrationExecutor } from './migrations/migration-executor'
import { IPgComponent } from '@well-known-components/pg-component'
import { AuthIdentity } from '@dcl/crypto'

export type GlobalContext = {
  components: BaseComponents
}

export type DeploymentToValidate = {
  entity: Entity
  files: Map<string, Uint8Array>
  authChain: AuthChain
  contentHashesInStorage: Map<string, boolean>
}

export type WorldRuntimeMetadata = {
  entityIds: string[]
  name: string
  minimapVisible: boolean
  minimapDataImage?: string
  minimapEstateImage?: string
  skyboxFixedTime?: number
  skyboxTextures?: string[]
  fixedAdapter?: string
  thumbnailFile?: string
}

export type WorldMetadata = {
  entityId: string
  acl?: AuthChain
  permissions: Permissions
  runtimeMetadata: WorldRuntimeMetadata
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
  'config' | 'limitsManager' | 'nameDenyListChecker' | 'namePermissionChecker' | 'storage' | 'worldsManager'
>

export type MigratorComponents = Pick<AppComponents, 'logs' | 'database' | 'storage' | 'worldsManager'>

export type Validation = (deployment: DeploymentToValidate) => ValidationResult | Promise<ValidationResult>

export type INameOwnership = {
  findOwner(worldName: string): Promise<EthAddress | undefined>
}

export type IWorldNamePermissionChecker = {
  checkPermission(ethAddress: EthAddress, worldName: string): Promise<boolean>
}

export type INameDenyListChecker = {
  checkNameDenyList(worldName: string): Promise<boolean>
}

export type WorldStatus = {
  worldName: string
  users: number
}

export type WorldData = {
  name: string
  scenes: SceneData[]
}

export type SceneData = {
  id: string
  title: string
  description: string
  thumbnail?: string
  pointers: string[]
  timestamp: number
  runtimeVersion?: string
}

export type CommsStatus = {
  adapterType: string
  statusUrl: string
  commitHash?: string
  users: number
  rooms: number
  details?: WorldStatus[]
  timestamp: number
}

export type ICommsAdapter = {
  connectionString(ethAddress: EthAddress, roomId: string, name?: string): Promise<string>
  status(): Promise<CommsStatus>
}

export type ILimitsManager = {
  getAllowSdk6For(worldName: string): Promise<boolean>
  getMaxAllowedParcelsFor(worldName: string): Promise<number>
  getMaxAllowedSizeInMbFor(worldName: string): Promise<number>
}

export type IWorldsManager = {
  getDeployedWorldCount(): Promise<number>
  getDeployedWorldEntities(): Promise<Entity[]>
  getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined>
  getEntityForWorld(worldName: string): Promise<Entity | undefined>
  deployScene(worldName: string, scene: Entity): Promise<void>
  storePermissions(worldName: string, permissions: Permissions): Promise<void>
  permissionCheckerForWorld(worldName: string): Promise<IPermissionChecker>
}

export type IPermissionsManager = {
  getPermissions(worldName: string): Promise<Permissions>
  storePermissions(worldName: string, permissions: Permissions): Promise<void>
  addAddressToAllowList(worldName: string, permission: Permission, address: string): Promise<void>
  deleteAddressFromAllowList(worldName: string, permission: Permission, address: string): Promise<void>
}

export enum PermissionType {
  Unrestricted = 'unrestricted',
  SharedSecret = 'shared-secret',
  NFTOwnership = 'nft-ownership',
  AllowList = 'allow-list'
}

export type UnrestrictedPermissionSetting = {
  type: PermissionType.Unrestricted
}

export type SharedSecretPermissionSetting = {
  type: PermissionType.SharedSecret
  secret: string
}

export type NftOwnershipPermissionSetting = {
  type: PermissionType.NFTOwnership
  nft: string
}

export type AllowListPermissionSetting = {
  type: PermissionType.AllowList
  wallets: string[]
}

export type AccessPermissionSetting =
  | UnrestrictedPermissionSetting
  | SharedSecretPermissionSetting
  | NftOwnershipPermissionSetting
  | AllowListPermissionSetting

export type Permissions = {
  deployment: AllowListPermissionSetting
  access: AccessPermissionSetting
  streaming: UnrestrictedPermissionSetting | AllowListPermissionSetting
}

export type Permission = keyof Permissions

export type IPermissionChecker = {
  checkPermission(permission: Permission, ethAddress: EthAddress, extras?: any): Promise<boolean>
}

export type WorldsIndex = {
  index: WorldData[]
  timestamp: number
}

export type IWorldsIndexer = {
  getIndex(): Promise<WorldsIndex>
}

export type DeploymentResult = {
  message: string
}

export type IEntityDeployer = {
  deployEntity(
    baseUrl: string,
    entity: Entity,
    allContentHashesInStorage: Map<string, boolean>,
    files: Map<string, Uint8Array>,
    entityJson: string,
    authChain: AuthLink[]
  ): Promise<DeploymentResult>
}

// components used in every environment
export type BaseComponents = {
  commsAdapter: ICommsAdapter
  config: IConfigComponent
  database: IPgComponent
  entityDeployer: IEntityDeployer
  ethereumProvider: HTTPProvider
  fetch: IFetchComponent
  limitsManager: ILimitsManager
  logs: ILoggerComponent
  marketplaceSubGraph: ISubgraphComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  migrationExecutor: MigrationExecutor
  nameDenyListChecker: INameDenyListChecker
  nameOwnership: INameOwnership
  namePermissionChecker: IWorldNamePermissionChecker
  permissionsManager: IPermissionsManager
  server: IHttpServerComponent<GlobalContext>
  sns: SnsComponent
  status: IStatusComponent
  storage: IContentStorageComponent
  validator: Validator
  worldsIndexer: IWorldsIndexer
  worldsManager: IWorldsManager
}

export type SnsComponent = { arn?: string }

export type IWorldCreator = {
  createWorldWithScene(data?: {
    worldName?: string
    metadata?: any
    files?: Map<string, ArrayBuffer>
    permissions?: Permissions
    owner?: AuthIdentity
  }): Promise<{ worldName: string; entityId: IPFSv2; entity: Entity; owner: AuthIdentity }>
  randomWorldName(): string
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
  worldCreator: IWorldCreator
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

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, this.constructor)
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, this.constructor)
  }
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, this.constructor)
  }
}

export interface ErrorResponse {
  error: string
  message: string
}
