import type {
  IBaseComponent,
  IConfigComponent,
  IHttpServerComponent,
  ILoggerComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { PaginatedParameters } from '@dcl/schemas'
import { metricDeclarations } from './metrics'
import { IContentStorageComponent } from '@dcl/catalyst-storage'
import { HTTPProvider } from 'eth-connect'
import { ISubgraphComponent } from '@well-known-components/thegraph-component'
import { IStatusComponent } from './adapters/status'
import { AuthChain, AuthLink, Entity, EthAddress, IPFSv2 } from '@dcl/schemas'
import { MigrationExecutor } from './adapters/migration-executor'
import { IPgComponent } from '@well-known-components/pg-component'
import { AuthIdentity, IdentityType } from '@dcl/crypto'
import { IFetchComponent } from '@well-known-components/interfaces'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'

// Type for authenticated test fetch component
export type TestIdentity = { authChain: AuthIdentity; realAccount: IdentityType; ephemeralIdentity: IdentityType }
export type AuthenticatedRequestInit = Omit<RequestInit, 'body'> & {
  identity?: TestIdentity
  metadata?: Record<string, any>
  body?: any
}
export type IAuthenticatedFetchComponent = {
  fetch(path: string, init?: AuthenticatedRequestInit): Promise<Response>
}
import { WebhookEvent } from 'livekit-server-sdk'
import { IPublisherComponent } from '@dcl/sns-component'
import { ISettingsComponent } from './logic/settings'
import { ISchemaValidatorComponent } from '@dcl/schema-validator-component'
import { ICoordinatesComponent } from './logic/coordinates'

import {
  IPermissionsComponent,
  AllowListPermission,
  WorldPermissionRecord,
  WorldPermissionRecordForChecking
} from './logic/permissions'
import { AccessSetting, IAccessComponent } from './logic/access'

export type GlobalContext = {
  components: BaseComponents
}

export const MB = 1024 * 1024
export const MB_BigInt = 1024n * 1024n
export const MAX_PARCELS_PER_PERMISSION = 500

export type Migration = {
  id: string
  run: (components: MigratorComponents) => Promise<void>
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
  description?: string
  minimapVisible: boolean
  minimapDataImage?: string
  minimapEstateImage?: string
  skyboxFixedTime?: number
  skyboxTextures?: string[]
  fixedAdapter?: string
  thumbnailFile?: string
}

export type WorldSettings = {
  spawnCoordinates?: string
}

export type WorldScene = {
  worldName: string
  deployer: string
  deploymentAuthChain: AuthChain
  entity: Entity
  entityId: IPFSv2
  parcels: string[]
  size: bigint
  createdAt: Date
}

export type GetWorldScenesFilters = {
  worldName?: string
  coordinates?: string[]
}

export enum SceneOrderBy {
  CreatedAt = 'created_at'
}

export enum OrderDirection {
  Asc = 'asc',
  Desc = 'desc'
}

export type GetWorldScenesOptions = PaginatedParameters & {
  orderBy?: SceneOrderBy
  orderDirection?: OrderDirection
}

export type GetWorldScenesResult = {
  scenes: WorldScene[]
  total: number
}

export type WorldMetadata = {
  access: AccessSetting
  spawnCoordinates: string | null
  runtimeMetadata: WorldRuntimeMetadata
  scenes: WorldScene[]
  blockedSince?: Date
  owner?: EthAddress
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
  | 'config'
  | 'limitsManager'
  | 'nameDenyListChecker'
  | 'namePermissionChecker'
  | 'permissions'
  | 'storage'
  | 'worldsManager'
>

export type MigratorComponents = Pick<
  AppComponents,
  'logs' | 'database' | 'nameOwnership' | 'storage' | 'worldsManager'
>

export type Validation = (deployment: DeploymentToValidate) => ValidationResult | Promise<ValidationResult>

export type INameOwnership = {
  findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>>
}

export type IWorldNamePermissionChecker = {
  checkPermission(ethAddress: EthAddress, worldName: string): Promise<boolean>
}

export type INameDenyListChecker = {
  checkNameDenyList(worldName: string): Promise<boolean>
}

export type IRunnable<T> = {
  run(): Promise<T>
  start(): Promise<void>
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
  getMaxAllowedSizeInBytesFor(worldName: string): Promise<bigint>
}

export type WorldBoundingRectangle = {
  min: { x: number; y: number }
  max: { x: number; y: number }
}

export type IWorldsManager = {
  getRawWorldRecords(): Promise<WorldRecord[]>
  getDeployedWorldCount(): Promise<{ ens: number; dcl: number }>
  getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined>
  getEntityForWorlds(worldNames: string[]): Promise<Entity[]>
  deployScene(worldName: string, scene: Entity, owner: EthAddress): Promise<void>
  undeployScene(worldName: string, parcels: string[]): Promise<void>
  storeAccess(worldName: string, access: AccessSetting): Promise<void>
  undeployWorld(worldName: string): Promise<void>
  getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }>
  getWorldScenes(filters?: GetWorldScenesFilters, options?: GetWorldScenesOptions): Promise<GetWorldScenesResult>
  updateWorldSettings(worldName: string, settings: WorldSettings): Promise<void>
  getWorldSettings(worldName: string): Promise<WorldSettings | undefined>
  getTotalWorldSize(worldName: string): Promise<bigint>
  getWorldBoundingRectangle(worldName: string): Promise<WorldBoundingRectangle | undefined>
}

export type IPermissionsManager = {
  getOwner(worldName: string): Promise<EthAddress | undefined>
  grantAddressesWorldWidePermission(
    worldName: string,
    permission: AllowListPermission,
    addresses: string[]
  ): Promise<string[]>
  removeAddressesPermission(worldName: string, permission: AllowListPermission, addresses: string[]): Promise<string[]>
  getAddressPermissions(
    worldName: string,
    permission: AllowListPermission,
    address: string
  ): Promise<WorldPermissionRecord | undefined>
  getParcelsForPermission(
    permissionId: number,
    limit?: number,
    offset?: number,
    boundingBox?: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<ParcelsResult>
  getWorldPermissionRecords(worldName: string): Promise<WorldPermissionRecordForChecking[]>
  checkParcelsAllowed(permissionId: number, parcels: string[]): Promise<boolean>
  hasPermissionEntries(worldName: string, permission: AllowListPermission): Promise<boolean>
  addParcelsToPermission(
    worldName: string,
    permission: AllowListPermission,
    address: string,
    parcels: string[]
  ): Promise<{ created: boolean }>
  removeParcelsFromPermission(permissionId: number, parcels: string[]): Promise<void>
}

export type INotificationService = {
  sendNotifications(notifications: Notification[]): Promise<void>
}

export type Notification = {
  eventKey: string
  type: string
  address?: string
  metadata: object
  timestamp: number
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

export type AwsConfig = {
  region: string
  credentials?: { accessKeyId: string; secretAccessKey: string }
  endpoint?: string
  forcePathStyle?: boolean // for SDK v3
  s3ForcePathStyle?: boolean // for SDK v2
}

export type LivekitClient = {
  receiveWebhookEvent(body: string, authorization: string): Promise<WebhookEvent>
}

export type IPeersRegistry = {
  onPeerConnected(id: string, roomName: string): void
  onPeerDisconnected(id: string): void
  getPeerWorld(id: string): string | undefined
}

// components used in every environment
export type BaseComponents = {
  access: IAccessComponent
  awsConfig: AwsConfig
  commsAdapter: ICommsAdapter
  config: IConfigComponent
  coordinates: ICoordinatesComponent
  database: IPgComponent
  entityDeployer: IEntityDeployer
  ethereumProvider: HTTPProvider
  fetch: IFetchComponent
  limitsManager: ILimitsManager
  livekitClient: LivekitClient
  logs: ILoggerComponent
  marketplaceSubGraph: ISubgraphComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  migrationExecutor: MigrationExecutor
  nats: INatsComponent
  nameDenyListChecker: INameDenyListChecker
  nameOwnership: INameOwnership
  namePermissionChecker: IWorldNamePermissionChecker
  notificationService: INotificationService
  permissions: IPermissionsComponent
  permissionsManager: IPermissionsManager
  peersRegistry: IPeersRegistry
  server: IHttpServerComponent<GlobalContext>
  snsClient: IPublisherComponent
  status: IStatusComponent
  storage: IContentStorageComponent
  updateOwnerJob: IRunnable<void>
  validator: Validator
  walletStats: IWalletStats
  worldsIndexer: IWorldsIndexer
  worldsManager: IWorldsManager
  settings: ISettingsComponent
  schemaValidator: ISchemaValidatorComponent<GlobalContext>
}

export type IWorldCreator = {
  createWorldWithScene(data?: {
    worldName?: string
    metadata?: any
    files?: Map<string, Uint8Array>
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
  // A fetch component that only hits the test server with optional authentication support
  localFetch: IAuthenticatedFetchComponent
  worldCreator: IWorldCreator
  // Mocked version of nameOwnership for testing
  nameOwnership: jest.Mocked<INameOwnership>
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

export interface ErrorResponse {
  error: string
  message: string
}

type WhitelistEntry = {
  max_parcels?: number
  max_size_in_mb?: number
  allow_sdk6?: boolean
}

export type Whitelist = {
  [worldName: string]: WhitelistEntry | undefined
}

export type WalletStats = {
  wallet: EthAddress
  dclNames: { name: string; size: bigint }[]
  ensNames: { name: string; size: bigint }[]
  usedSpace: bigint
  maxAllowedSpace: bigint
  blockedSince?: Date
}

export type IWalletStats = {
  get(wallet: EthAddress): Promise<WalletStats>
}

export type WorldRecord = {
  name: string
  owner: string
  spawn_coordinates: string | null
  created_at: Date
  updated_at: Date
  blocked_since: Date | null
}

export type BlockedRecord = { wallet: string; created_at: Date; updated_at: Date }

export const TWO_DAYS_IN_MS = 2 * 24 * 60 * 60 * 1000

export type ContributorDomain = {
  name: string
  user_permissions: string[]
  owner: string
  size: string
  parcelCount: number // 0 = world-wide, number = specific parcels count
}

export type PaginatedResult<T> = {
  total: number
  results: T[]
}

export type ParcelsResult = PaginatedResult<string>
