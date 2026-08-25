import { Router } from '@dcl/http-server'
import {
  createInFlightUploadBudget,
  InFlightUploadBudget,
  InFlightUploadBudgetSnapshot,
  MAX_WORLD_SETTINGS_UPLOAD_SIZE_IN_BYTES,
  MultipartCleanupErrorEvent,
  multipartParserWrapper,
  MultipartTelemetryEvent
} from '../logic/multipart'
import { BaseComponents, GlobalContext } from '../types'
import { availableContentHandler, getContentFile, headContentFile } from './handlers/content-file-handler'
import { deployEntity } from './handlers/deploy-entity-handler'
import { worldAboutHandler } from './handlers/world-about-handler'
import { statusHandler } from './handlers/status-handler'
import { commsAdapterHandler } from './handlers/comms-adapter-handler'
import { activeEntitiesHandler } from './handlers/active-entities'
import { getIndexHandler } from './handlers/index-handler'
import { getLiveDataHandler } from './handlers/live-data-handler'
import { rejectIfSigner, wellKnownComponents } from '@dcl/crypto-middleware'
import {
  deletePermissionsAccessCommunityHandler,
  deletePermissionsAddressHandler,
  deletePermissionParcelsHandler,
  getAddressesForParcelPermissionHandler,
  getAllowedParcelsForPermissionHandler,
  getPermissionsHandler,
  postPermissionsHandler,
  postPermissionParcelsHandler,
  putPermissionsAccessCommunityHandler,
  putPermissionsAddressHandler
} from './handlers/permissions-handlers'
import { walletStatsHandler } from './handlers/wallet-stats-handler'
import { undeployEntity } from './handlers/undeploy-entity-handler'
import { bearerTokenMiddleware, errorHandler } from '@dcl/http-commons'
import { reprocessABHandler } from './handlers/reprocess-ab-handler'
import { garbageCollectionHandler } from './handlers/garbage-collection'
import { getContributableDomainsHandler } from './handlers/contributor-handler'
import { livekitWebhookHandler } from './handlers/livekit-webhook-handler'
import { walletConnectedWorldHandler } from './handlers/wallet-connected-world-handler'
import { getScenesHandler, undeploySceneHandler } from './handlers/scenes-handler'
import { getWorldSettingsHandler, updateWorldSettingsHandler } from './handlers/world-settings-handler'
import { getWorldManifestHandler } from './handlers/world-manifest-handler'
import { permissionParcelsSchema } from './schemas/permission-parcels-schema'
import { getWorldsHandler } from './handlers/worlds-handler'
import { reprocessABSchema } from './schemas/reprocess-ab-schemas'
import { getWorldScenesSchema } from './schemas/scenes-query-schemas'
import { worldCommsHandler } from './handlers/world-comms-handler'

export type MultipartUploadGuard = {
  inFlightUploadBudget: InFlightUploadBudget
  uploadTimeoutMs: number | undefined
  onTelemetry: (event: MultipartTelemetryEvent) => void
  onCleanupError: (event: MultipartCleanupErrorEvent) => void
}

/**
 * Creates the process-wide multipart limiter and connects its state and outcomes to application
 * metrics and logs. All multipart routes must share the returned budget.
 *
 * @param components Configuration, logging, and metrics dependencies used by the limiter.
 * @returns The shared upload budget, configured timeout, telemetry callback, and cleanup-error callback.
 */
export async function createMultipartUploadGuard(
  components: Pick<BaseComponents, 'config' | 'logs' | 'metrics'>
): Promise<MultipartUploadGuard> {
  const { config, logs, metrics } = components
  const logger = logs.getLogger('multipart-uploads')
  const maxInFlightUploadBytes = await config.getNumber('MAX_IN_FLIGHT_UPLOAD_BYTES')
  const maxConcurrentUploads = await config.getNumber('MAX_CONCURRENT_UPLOADS')
  const maxInFlightUploadFiles = await config.getNumber('MAX_IN_FLIGHT_UPLOAD_FILES')
  const maxOrphanedUploadDirectories = await config.getNumber('MAX_ORPHANED_UPLOAD_DIRECTORIES')
  const uploadTimeoutMs = await config.getNumber('MULTIPART_UPLOAD_TIMEOUT_MS')
  const onStateChange = ({
    reservedBytes,
    orphanedBytes,
    reservedFiles,
    orphanedFiles,
    orphanedDirectories,
    activeUploads
  }: InFlightUploadBudgetSnapshot): void => {
    metrics.observe('multipart_upload_reserved_bytes', {}, reservedBytes)
    metrics.observe('multipart_upload_orphaned_bytes', {}, orphanedBytes)
    metrics.observe('multipart_upload_reserved_files', {}, reservedFiles)
    metrics.observe('multipart_upload_orphaned_files', {}, orphanedFiles)
    metrics.observe('multipart_upload_orphaned_directories', {}, orphanedDirectories)
    metrics.observe('multipart_upload_active', {}, activeUploads)
  }
  const inFlightUploadBudget = createInFlightUploadBudget(
    maxInFlightUploadBytes,
    maxConcurrentUploads,
    onStateChange,
    maxInFlightUploadFiles,
    maxOrphanedUploadDirectories
  )
  const onTelemetry = (event: MultipartTelemetryEvent): void => {
    metrics.observe(
      'multipart_upload_size_bytes',
      {
        route: event.route,
        content_length: event.contentLengthPresent ? 'present' : 'absent',
        outcome: event.kind
      },
      event.actualBytes
    )
    if (event.kind === 'rejected') {
      metrics.increment('multipart_upload_rejections', { route: event.route, reason: event.reason })
      logger.warn('Multipart upload rejected', {
        route: event.route,
        reason: event.reason,
        actualBytes: event.actualBytes,
        reservedBytes: event.snapshot.reservedBytes,
        orphanedBytes: event.snapshot.orphanedBytes,
        reservedFiles: event.snapshot.reservedFiles,
        orphanedFiles: event.snapshot.orphanedFiles,
        orphanedDirectories: event.snapshot.orphanedDirectories,
        capacity: event.snapshot.capacity,
        maxInFlightUploadFiles: event.snapshot.maxInFlightUploadFiles,
        maxOrphanedUploadDirectories: event.snapshot.maxOrphanedUploadDirectories,
        activeUploads: event.snapshot.activeUploads,
        maxConcurrentUploads: event.snapshot.maxConcurrentUploads,
        contentLengthPresent: String(event.contentLengthPresent)
      })
    }
  }
  const onCleanupError = ({ route, error, attempt, willRetry }: MultipartCleanupErrorEvent): void => {
    if (attempt === 0) {
      metrics.increment('multipart_upload_cleanup_failures', { route })
    } else {
      metrics.increment('multipart_upload_cleanup_retry_failures', { route })
    }
    logger.warn('Failed to clean up multipart upload directory', {
      route,
      error: error.message,
      attempt,
      willRetry: String(willRetry)
    })
  }

  return { inFlightUploadBudget, uploadTimeoutMs, onTelemetry, onCleanupError }
}

export async function setupRouter(globalContext: GlobalContext): Promise<Router<GlobalContext>> {
  const { fetch, schemaValidator, config } = globalContext.components

  /**
   * Builds a signed-fetch middleware.
   *
   * @param canonicalMetadataKeys When present, opts the routes using this instance into accepting
   *   the pre-6.0.0 signed payload as a fallback. Absent — the default — means current format only.
   */
  const createSignedFetchMiddleware = (canonicalMetadataKeys?: string[]) =>
    wellKnownComponents({
      fetcher: fetch,
      optional: false,
      // Scene-originated requests are refused here: the explorer stamps `decentraland-kernel-scene`
      // as the signer for them, and none of the routes below may be driven by scene code.
      //
      // The predicate refuses a `signer` that is not already canonical rather than folding it before
      // comparing, so a re-spelled or padded value cannot read as "not a scene" and slip past. The
      // value reaching handlers is still exactly what the client signed — nothing is rewritten.
      //
      // It also runs before signature verification, so it guards the legacy fallback below as well
      // as the current-format path.
      metadataValidator: rejectIfSigner('decentraland-kernel-scene'),
      canonicalMetadataKeys,
      onError: (err: any) => ({
        error: err.message,
        message: 'This endpoint requires a signed fetch request. See ADR-44.'
      })
    })

  // Strict: current signed-payload format only. Everything the builder, the CLI and the admin
  // tooling drive stays here — those callers ship with the format they sign and can be sequenced
  // ahead of a deploy, so they get no fallback.
  const signedFetchMiddleware = createSignedFetchMiddleware()

  // Explorer comms handshakes only. The unity, godot and bevy clients each still sign the pre-6.0.0
  // folded payload and each send camelCase metadata, so every one of their handshakes 401s under
  // 6.x. They are three separate client releases and cannot be deployed atomically with this
  // service, so there is no deploy order that avoids breaking them; this accepts the old payload
  // for the duration of that window. Remove it — and this second instance — once the clients ship.
  //
  // The legacy payload folds the metadata, so its casing is outside the signature and a delivered
  // `{"Signer":…}` would share a valid signature with `{"signer":…}` while reading as absent to the
  // scene gate above. Listing the keys this service authorizes on is what closes that: a legacy
  // request spelling any of them differently is refused with a 400 rather than having its metadata
  // rewritten. Derived from the reads in this repo, not from what clients happen to send:
  //
  //   signer  the scene gate above; `metadata.signer` in comms-adapter-handler
  //   intent  `metadata.intent` in comms-adapter-handler
  //   secret  `authMetadata.secret` in comms-adapter-handler and world-comms-handler
  //
  // Scoped to exactly the fields the three routes below read, so the list doubles as the statement
  // of how far this temporary relaxation reaches. The permissions fields — `type`, `wallets`,
  // `communities`, `nft`, `secret` — get their own instance below rather than being folded in here;
  // naming them on this one would cost nothing at runtime, since the guard only inspects keys a
  // request actually delivers, but it would describe a boundary wider than the one that exists, and
  // moving a route between instances should be a deliberate edit.
  //
  // Deliberately absent for the same reason: `isGuest`, `origin`, `realmName`, `realm.serverName`
  // and metadata `sceneId` are sent by the explorers but never read here, and an unread field
  // cannot change an authorization decision. The scene comms route takes its `sceneId` from the URL
  // path, not the metadata.
  const explorerSignedFetchMiddleware = createSignedFetchMiddleware(['signer', 'intent', 'secret'])

  // `POST /world/:world_name/permissions/:permission_name` only. creator-hub drives the world
  // access dialogs through this route and still resolves decentraland-crypto-fetch 2.0.1, so it
  // signs the folded payload. Everything it sends here carries uppercase — `{"type":"shared-secret",
  // "secret":"…"}` for a password, camelCase wallet and community lists for an allow list — so every
  // one of those calls 401s under 6.x. Setting a world password is the flow that breaks.
  //
  // It cannot be sequenced ahead of this deploy the way the builder and the CLI can: creator-hub is
  // a shipped Electron desktop app, so old builds keep calling after the server updates. That is the
  // same argument the explorer instance above exists for.
  //
  // Its other eight calls to this service send no metadata at all, so this is the only route that
  // needs it — `PUT`/`DELETE` on the per-address permission routes stay strict.
  //
  // Keys read by `postPermissionsHandler`, plus the scene gate's:
  //
  //   signer                          the gate in `createSignedFetchMiddleware` above
  //   type, wallets                   read directly for the deployment and streaming permissions
  //   type, secret, wallets,          the whole metadata is cast to `AccessInput` for `access`
  //     communities, nft
  //
  // What this cannot do, stated plainly: a key list binds key *spellings*. The fold puts property
  // *values* outside the signature too, and no list can bind those. On this route that means a
  // legacy-signed `secret` is malleable in transit — an attacker positioned to alter the request can
  // change the password's casing. The bound is that they must already be able to read and rewrite a
  // request the world's owner signed (`checkOwnership` gates on the recovered address), and the
  // secret travels in cleartext in that same request, so they already know it: the reachable outcome
  // is locking the owner out, not learning anything. Weighed against every creator-hub install being
  // unable to set a world password, that is the better failure — but it is a real cost, and it is
  // why this instance is scoped to one route and why the creator-hub bump is the actual fix.
  const permissionsSignedFetchMiddleware = createSignedFetchMiddleware([
    'signer',
    'type',
    'secret',
    'wallets',
    'communities',
    'nft'
  ])

  const router = new Router<GlobalContext>()
  router.use(errorHandler)

  // Aggregate buffered-bytes budget for multipart uploads. Tune per container ephemeral storage;
  // falls back to the parser's default when unset.
  const { inFlightUploadBudget, uploadTimeoutMs, onTelemetry, onCleanupError } = await createMultipartUploadGuard(
    globalContext.components
  )

  router.get('/world/:world_name/about', worldAboutHandler)

  // Post world scene(s)
  router.post(
    '/entities',
    multipartParserWrapper(deployEntity, {
      inFlightUploadBudget,
      uploadTimeoutMs,
      route: 'entities',
      onTelemetry,
      onCleanupError
    })
  )
  // Undeploy the whole world
  router.delete('/entities/:world_name', signedFetchMiddleware, undeployEntity)
  router.get('/available-content', availableContentHandler)

  // Multi-scene management
  router.get('/world/:world_name/scenes', getScenesHandler)
  router.post(
    '/world/:world_name/scenes',
    schemaValidator.withSchemaValidatorMiddleware(getWorldScenesSchema),
    getScenesHandler
  )
  // Undeploy a scene
  router.delete('/world/:world_name/scenes/:coordinate', signedFetchMiddleware, undeploySceneHandler)

  // World settings
  router.get('/world/:world_name/settings', getWorldSettingsHandler)
  router.put(
    '/world/:world_name/settings',
    signedFetchMiddleware,
    multipartParserWrapper(updateWorldSettingsHandler, {
      inFlightUploadBudget,
      maxSizeInBytes: MAX_WORLD_SETTINGS_UPLOAD_SIZE_IN_BYTES,
      uploadTimeoutMs,
      route: 'world-settings',
      onTelemetry,
      onCleanupError
    })
  )

  // World manifest
  router.get('/world/:world_name/manifest', getWorldManifestHandler)

  // Worlds listing
  router.get('/worlds', getWorldsHandler)

  // consumption
  router.head('/ipfs/:hashId', headContentFile)
  router.get('/ipfs/:hashId', getContentFile)

  router.post('/entities/active', activeEntitiesHandler)
  router.head('/contents/:hashId', headContentFile)
  router.get('/contents/:hashId', getContentFile)

  router.get('/wallet/contribute', signedFetchMiddleware, getContributableDomainsHandler)

  // Permissions endpoints
  router.get('/world/:world_name/permissions', getPermissionsHandler)
  router.post(
    '/world/:world_name/permissions/:permission_name',
    permissionsSignedFetchMiddleware,
    postPermissionsHandler
  )

  // Address-specific permission endpoints
  // GET: Paginated parcels for a specific address
  router.get(
    '/world/:world_name/permissions/:permission_name/address/:address/parcels',
    getAllowedParcelsForPermissionHandler
  )
  // POST: Add parcels to an existing permission
  router.post(
    '/world/:world_name/permissions/:permission_name/address/:address/parcels',
    signedFetchMiddleware,
    schemaValidator.withSchemaValidatorMiddleware(permissionParcelsSchema),
    postPermissionParcelsHandler
  )
  // DELETE: Remove parcels from an existing permission
  router.delete(
    '/world/:world_name/permissions/:permission_name/address/:address/parcels',
    signedFetchMiddleware,
    schemaValidator.withSchemaValidatorMiddleware(permissionParcelsSchema),
    deletePermissionParcelsHandler
  )

  // Parcel-specific: paginated addresses with a given permission for the provided parcels
  router.post(
    '/world/:world_name/permissions/:permission_name/parcels',
    schemaValidator.withSchemaValidatorMiddleware(permissionParcelsSchema),
    getAddressesForParcelPermissionHandler
  )

  // Access allow-list: add/remove single community (world must have allow-list access)
  // Registered before :permission_name/:address so /access/communities/:id is matched first
  router.put(
    '/world/:world_name/permissions/access/communities/:communityId',
    signedFetchMiddleware,
    putPermissionsAccessCommunityHandler
  )
  router.delete(
    '/world/:world_name/permissions/access/communities/:communityId',
    signedFetchMiddleware,
    deletePermissionsAccessCommunityHandler
  )

  // PUT: Set permission (create or replace) - grants world-wide permission
  router.put(
    '/world/:world_name/permissions/:permission_name/:address',
    signedFetchMiddleware,
    putPermissionsAddressHandler
  )

  // DELETE: Revoke permission
  router.delete(
    '/world/:world_name/permissions/:permission_name/:address',
    signedFetchMiddleware,
    deletePermissionsAddressHandler
  )

  router.get('/wallet/:wallet/stats', walletStatsHandler)
  router.get('/wallet/:wallet/connected-world', walletConnectedWorldHandler)
  router.get('/status', statusHandler)

  // @deprecated This endpoint is no longer used and will be removed in the future.
  router.get('/index', getIndexHandler)
  router.get('/live-data', getLiveDataHandler)

  router.post('/livekit-webhook', livekitWebhookHandler)

  // Comms endpoints. These three are the explorer handshakes, and the only routes that accept the
  // legacy signed payload — see `explorerSignedFetchMiddleware` above.
  router.post('/worlds/:worldName/comms', explorerSignedFetchMiddleware, worldCommsHandler)
  router.post('/worlds/:worldName/scenes/:sceneId/comms', explorerSignedFetchMiddleware, worldCommsHandler)

  router.post('/get-comms-adapter/:roomId', explorerSignedFetchMiddleware, commsAdapterHandler)

  // administrative endpoints
  const secret = await config.requireString('AUTH_SECRET')
  if (secret) {
    router.post(
      '/reprocess-ab',
      bearerTokenMiddleware(secret),
      schemaValidator.withSchemaValidatorMiddleware(reprocessABSchema),
      reprocessABHandler
    )
    router.post('/gc', bearerTokenMiddleware(secret), garbageCollectionHandler)
  }
  return router
}
