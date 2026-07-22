import type {
  IBaseComponent,
  IConfigComponent,
  ILoggerComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import type { IHttpServerComponent } from '@dcl/core-commons'
import { PaginatedParameters } from '@dcl/schemas'
import { metricDeclarations } from './metrics'
import { FileInfo, IContentStorageComponent } from '@dcl/catalyst-storage'
import { HTTPProvider } from 'eth-connect'
import { ISubgraphComponent } from '@dcl/thegraph-component'
import { IStatusComponent } from './adapters/status'
import { IBlockingComponent } from './adapters/blocking'
import { IWhitelistComponent } from './adapters/whitelist'
import { AuthChain, AuthLink, Entity, EthAddress, IPFSv2 } from '@dcl/schemas'
import { Readable } from 'stream'
import { MigrationExecutor } from './adapters/migration-executor'
import { IPgComponent } from '@dcl/pg-component'
import { AuthIdentity } from '@dcl/crypto'
import { IFetchComponent } from '@dcl/core-commons'
import { INatsComponent } from '@well-known-components/nats-component/dist/types'
import type { Room, VideoGrant, WebhookEvent } from 'livekit-server-sdk'
import { IPublisherComponent } from '@dcl/sns-component'
import { ISettingsComponent } from './logic/settings'
import { ISchemaValidatorComponent } from '@dcl/schema-validator-component'
import { ICoordinatesComponent } from './logic/coordinates'
import { ISearchComponent } from './adapters/search'
import {
  IPermissionsComponent,
  AllowListPermission,
  WorldPermissionRecord,
  WorldPermissionRecordForChecking
} from './logic/permissions'
import { AccessSetting, IAccessComponent } from './logic/access'
import { IAccessChangeHandler } from './logic/access-change-handler'
import { IAccessCheckerComponent } from './logic/access-checker'
import { ISocialServiceComponent } from './adapters/social-service'
import { ICommsComponent } from './logic/comms'
import { IRateLimiterComponent } from './logic/rate-limiter'
import { IWorldsComponent } from './logic/worlds'
import { IParticipantKicker } from './logic/participant-kicker'
import { IJobComponent } from '@dcl/job-component'
import { IQueueConsumerComponent } from '@dcl/queue-consumer-component'
import { ICacheStorageComponent } from '@dcl/core-commons'
import { IDenyListComponent } from './logic/denylist/types'
import { IBansComponent } from './adapters/bans-adapter'

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

/**
 * A file uploaded as part of a deployment. Backed by a temp file on disk so large content files
 * are never held in memory in full: callers stream them for hashing/storing and only read the
 * small entity JSON into a Buffer.
 */
export type DeploymentFile = {
  /** Size in bytes of the uploaded file. */
  size: number
  /** Opens a fresh read stream over the file's bytes (for hashing and storing). */
  getStream(signal?: AbortSignal): Readable
  /** Calculates and memoizes the file's CIDv1. */
  getHash(signal?: AbortSignal): Promise<string>
  /** Reads the full file into a Buffer. Intended for small files such as the entity JSON. */
  asBuffer(signal?: AbortSignal): Promise<Buffer>
}

export type DeploymentToValidate = {
  entity: Entity
  files: Map<string, DeploymentFile>
  authChain: AuthChain
  contentHashesInStorage: Map<string, boolean>
  /** Storage metadata fetched once before validation, keyed by unique content hash. */
  contentFileInfos?: Map<string, FileInfo | undefined>
  /** Cancels request-scoped processing after disconnect or the configured processing deadline. */
  signal?: AbortSignal
}

export type DeploymentProcessingStage = 'total' | 'authorization' | 'metadata' | 'hash' | 'storage' | 'persistence'

export type DeploymentAbortContext = {
  signal: AbortSignal
  /** Absolute wall-clock deadline for bounding the persistence transaction. */
  deadlineAt: number
  dispose(): void
}

export interface IDeploymentProcessingComponent extends IBaseComponent {
  /** Maximum number of content files uploaded concurrently by one deployment. */
  readonly storageConcurrency: number
  /** Maximum number of deployment files hashed concurrently by one deployment. */
  readonly hashConcurrency: number
  /** Maximum number of storage metadata lookups run concurrently by one deployment. */
  readonly fileInfoConcurrency: number
  /** Maximum time spent processing a deployment after its multipart body has been parsed. */
  readonly timeoutMs: number
  /** Combines an optional request signal with the configured processing deadline. */
  createAbortContext(parentSignal?: AbortSignal): DeploymentAbortContext
  /** Records the duration, item count, outcome, and active count for a processing stage. */
  trackStage<T>(stage: DeploymentProcessingStage, items: number, operation: () => Promise<T>): Promise<T>
  /** Records the number of workers currently active in a bounded processing stage. */
  trackWorker<T>(stage: DeploymentProcessingStage, operation: () => Promise<T>): Promise<T>
}

export type SceneDeploymentData = {
  /** Auth chain already validated for this deployment. */
  authChain: AuthChain
  /** Total unique content size already calculated during validation. */
  size: number
  /** Absolute processing deadline used to bound the persistence transaction. */
  deadlineAt?: number
  /** Cancels persistence until the transaction reaches its commit boundary. */
  signal?: AbortSignal
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
  title?: string
  description?: string
  contentRating?: string
  spawnCoordinates?: string
  skyboxTime?: number | null
  categories?: string[] | null
  singlePlayer?: boolean
  showInPlaces?: boolean
  thumbnailHash?: string
}

export type WorldSettingsInput = {
  title?: string
  description?: string
  contentRating?: string
  spawnCoordinates?: string
  skyboxTime?: number | null
  categories?: string[] | null
  singlePlayer?: boolean
  showInPlaces?: boolean
  thumbnail?: Buffer
}

export enum SceneDeploymentStatus {
  Deployed = 'DEPLOYED',
  Undeployed = 'UNDEPLOYED'
}

export type WorldScene = {
  worldName: string
  deployer: string
  deploymentAuthChain: AuthChain
  entity: Entity
  entityId: IPFSv2
  parcels: string[]
  size: bigint
  status: SceneDeploymentStatus
  createdAt: Date
  updatedAt: Date
}

export type BoundingBox = {
  x1: number
  x2: number
  y1: number
  y2: number
}

export type GetWorldScenesFilters = {
  worldName?: string
  entityId?: string
  coordinates?: string[]
  boundingBox?: BoundingBox
  authorized_deployer?: string // address to filter scenes by (world owner or has deployment permission)
  includeUndeployed?: boolean
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

export type WorldShape = {
  x1: number
  x2: number
  y1: number
  y2: number
}

export type WorldInfo = {
  name: string
  owner: string
  title: string | null
  description: string | null
  shape: WorldShape | null
  contentRating: string | null
  spawnCoordinates: string | null
  skyboxTime: number | null
  categories: string[] | null
  singlePlayer: boolean | null
  showInPlaces: boolean | null
  thumbnailHash: string | null
  lastDeployedAt: Date | null
  blockedSince: Date | null
  deployedScenes: number
}

export type GetWorldsFilters = {
  authorized_deployer?: string // address to filter worlds by (owner or has deployment permission)
  search?: string
  has_deployed_scenes?: boolean
}

export enum WorldsOrderBy {
  Name = 'name',
  LastDeployedAt = 'last_deployed_at'
}

export type GetWorldsOptions = {
  limit?: number
  offset?: number
  orderBy?: WorldsOrderBy
  orderDirection?: OrderDirection
}

export type GetWorldsResult = {
  worlds: WorldInfo[]
  total: number
}

export type GetRawWorldRecordsFilters = {
  worldName?: string
}

export type GetRawWorldRecordsOptions = {
  limit?: number
  offset?: number
}

export type GetRawWorldRecordsResult = {
  records: WorldRecord[]
  total: number
}

export type GetOccupiedParcelsOptions = {
  limit?: number
  offset?: number
}

export type GetOccupiedParcelsResult = {
  parcels: string[]
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
  /** Validates an uploaded deployment without performing external content-storage lookups. */
  validateBeforeStorage(deployment: DeploymentToValidate): Promise<ValidationResult>
  /** Runs validations that require content-storage availability information. */
  validateAfterStorage(deployment: DeploymentToValidate): Promise<ValidationResult>
  /** Runs the complete validation pipeline. */
  validate(deployment: DeploymentToValidate): Promise<ValidationResult>
}

export type ValidationResult = {
  ok: () => boolean
  errors: string[]
}

export type ValidatorComponents = Pick<
  AppComponents,
  | 'config'
  | 'coordinates'
  | 'deploymentProcessing'
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
  getBannedNames(): Promise<string[]>
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
  getWorldRoomConnectionString(userId: EthAddress, worldName: string): Promise<string>
  getSceneRoomConnectionString(userId: EthAddress, worldName: string, sceneId: string): Promise<string>
  getWorldRoomParticipantCount(worldName: string): Promise<number>
  getWorldSceneRoomsParticipantCount(worldName: string): Promise<number>
  status(): Promise<CommsStatus>
  removeParticipant(roomName: string, identity: string): Promise<void>
}

export type ILimitsManager = {
  getAllowSdk6For(worldName: string): Promise<boolean>
  getMaxAllowedParcelsFor(worldName: string): Promise<number>
  getMaxAllowedSizeInBytesFor(worldName: string, parcels?: string[]): Promise<bigint>
}

export type WorldBoundingRectangle = {
  min: { x: number; y: number }
  max: { x: number; y: number }
}

export type WorldManifest = {
  parcels: string[]
  spawnCoordinates: string | null
  total: number
}

export type UpdateWorldSettingsResult = {
  settings: WorldSettings
  oldSpawnCoordinates: string | null
}

export class SpawnCoordinatesOutOfBoundsError extends Error {
  constructor(
    public readonly spawnCoordinates: string,
    public readonly boundingRectangle: WorldBoundingRectangle
  ) {
    super(`Spawn coordinates "${spawnCoordinates}" are outside the world bounding rectangle`)
    this.name = 'SpawnCoordinatesOutOfBoundsError'
  }
}

export class NoDeployedScenesError extends Error {
  constructor(public readonly worldName: string) {
    super(`World "${worldName}" has no deployed scenes`)
    this.name = 'NoDeployedScenesError'
  }
}

export type AccessModificationResult = {
  previousAccess: AccessSetting
  updatedAccess: AccessSetting
}

export type IWorldsManager = {
  getRawWorldRecords(
    filters?: GetRawWorldRecordsFilters,
    options?: GetRawWorldRecordsOptions
  ): Promise<GetRawWorldRecordsResult>
  getDeployedWorldCount(): Promise<{ ens: number; dcl: number }>
  getMetadataForWorld(worldName: string): Promise<WorldMetadata | undefined>
  getEntityForWorlds(worldNames: string[]): Promise<Entity[]>
  /** Persists a scene and its already-calculated deployment metadata. */
  deployScene(worldName: string, scene: Entity, owner: EthAddress, deployment?: SceneDeploymentData): Promise<void>
  undeployScene(worldName: string, parcels: string[]): Promise<void>
  storeAccess(worldName: string, access: AccessSetting): Promise<void>
  modifyAccessAtomically(
    worldName: string,
    modifier: (currentAccess: AccessSetting) => AccessSetting
  ): Promise<AccessModificationResult>
  undeployWorld(worldName: string): Promise<void>
  getContributableDomains(address: string): Promise<{ domains: ContributorDomain[]; count: number }>
  getWorldScenes(filters?: GetWorldScenesFilters, options?: GetWorldScenesOptions): Promise<GetWorldScenesResult>
  updateWorldSettings(worldName: string, owner: EthAddress, settings: WorldSettings): Promise<UpdateWorldSettingsResult>
  getWorldSettings(worldName: string): Promise<WorldSettings | undefined>
  getTotalWorldSize(worldName: string): Promise<bigint>
  getDeployedSceneSizeForParcels(worldName: string, parcels: string[]): Promise<bigint>
  getWorldBoundingRectangle(worldName: string): Promise<WorldBoundingRectangle | undefined>
  getWorlds(filters?: GetWorldsFilters, options?: GetWorldsOptions): Promise<GetWorldsResult>
  getOccupiedParcels(worldName: string, options?: GetOccupiedParcelsOptions): Promise<GetOccupiedParcelsResult>
  createBasicWorldIfNotExists(worldName: string, owner: EthAddress): Promise<void>
  worldExists(worldName: string): Promise<boolean>
  getWorldNamesByCommunityId(communityId: string): Promise<string[]>
  evictUndeployedScenes(olderThanMs: number): Promise<number>
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
  getAddressesForParcelPermission(
    worldName: string,
    permission: AllowListPermission,
    parcels: string[],
    limit?: number,
    offset?: number
  ): Promise<PaginatedResult<string>>
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
  getIndex(options?: GetRawWorldRecordsOptions): Promise<WorldsIndex>
}

export type DeploymentResult = {
  message: string
}

export type IEntityDeployer = {
  deployEntity(
    baseUrl: string,
    entity: Entity,
    allContentHashesInStorage: Map<string, boolean>,
    files: Map<string, DeploymentFile>,
    entityJson: string,
    authChain: AuthLink[],
    deploymentSize: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<DeploymentResult>
}

export type AwsConfig = {
  region: string
  credentials?: { accessKeyId: string; secretAccessKey: string }
  endpoint?: string
  forcePathStyle?: boolean // for SDK v3
  s3ForcePathStyle?: boolean // for SDK v2
}

export type CreateConnectionTokenOptions = {
  ttl?: number
}

export type RoomParticipantCount = {
  name: string
  numParticipants: number
}

export type ListRoomsWithParticipantCountsOptions = {
  namePrefix?: string
  chunkSize?: number
}

export type LivekitClient = {
  getRoom(roomId: string): Promise<Room | null>
  listRooms(roomNames?: string[]): Promise<Room[]>
  listRoomsWithParticipantCounts(options?: ListRoomsWithParticipantCountsOptions): Promise<RoomParticipantCount[]>
  createConnectionToken(identity: string, grant: VideoGrant, options?: CreateConnectionTokenOptions): Promise<string>
  receiveWebhookEvent(body: string, authorization: string): Promise<WebhookEvent>
  removeParticipant(roomName: string, identity: string): Promise<void>
}

export type IPeersRegistry = {
  onPeerConnected(id: string, roomName: string): void
  onPeerDisconnected(id: string, roomName: string): void
  getPeerWorld(id: string): string | undefined
  getPeersInWorld(worldName: string): string[]
  getPeerRooms(id: string): string[]
}

// components used in every environment
export type BaseComponents = {
  access: IAccessComponent
  accessChecker: IAccessCheckerComponent
  accessChangeHandler: IAccessChangeHandler
  awsConfig: AwsConfig
  blocking: IBlockingComponent
  commsAdapter: ICommsAdapter
  config: IConfigComponent
  coordinates: ICoordinatesComponent
  database: IPgComponent
  deploymentProcessing: IDeploymentProcessingComponent
  entityDeployer: IEntityDeployer
  ethereumProvider: HTTPProvider
  evictionJob: IJobComponent
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
  participantKicker: IParticipantKicker
  permissions: IPermissionsComponent
  permissionsManager: IPermissionsManager
  peersRegistry: IPeersRegistry
  queueConsumer: IQueueConsumerComponent
  search: ISearchComponent
  server: IHttpServerComponent<GlobalContext>
  snsClient: IPublisherComponent
  socialService: ISocialServiceComponent
  status: IStatusComponent
  storage: IContentStorageComponent
  updateOwnerJob: IRunnable<void>
  validator: Validator
  walletStats: IWalletStats
  whitelist: IWhitelistComponent
  worldsIndexer: IWorldsIndexer
  worldsManager: IWorldsManager
  settings: ISettingsComponent
  schemaValidator: ISchemaValidatorComponent<GlobalContext>
  comms: ICommsComponent
  denyList: IDenyListComponent
  rateLimiter: IRateLimiterComponent
  redis: ICacheStorageComponent
  bans: IBansComponent
  worlds: IWorldsComponent
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
  access: AccessSetting
  title: string | null
  description: string | null
  content_rating: string | null
  spawn_coordinates: string | null
  skybox_time: number | null
  categories: string[] | null
  single_player: boolean | null
  show_in_places: boolean | null
  thumbnail_hash: string | null
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
