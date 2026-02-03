import { Router } from '@well-known-components/http-server'
import { multipartParserWrapper } from '../logic/multipart'
import { GlobalContext } from '../types'
import { availableContentHandler, getContentFile, headContentFile } from './handlers/content-file-handler'
import { deployEntity } from './handlers/deploy-entity-handler'
import { worldAboutHandler } from './handlers/world-about-handler'
import { statusHandler } from './handlers/status-handler'
import { commsAdapterHandler } from './handlers/comms-adapter-handler'
import { activeEntitiesHandler } from './handlers/active-entities'
import { getIndexHandler } from './handlers/index-handler'
import { getLiveDataHandler } from './handlers/live-data-handler'
import { castAdapterHandler } from './handlers/cast-adapter-handler'
import { wellKnownComponents } from '@dcl/platform-crypto-middleware'
import {
  deletePermissionsAddressHandler,
  deletePermissionParcelsHandler,
  getAllowedParcelsForPermissionHandler,
  getPermissionsHandler,
  postPermissionsHandler,
  postPermissionParcelsHandler,
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
import { permissionParcelsSchema } from './schemas/permission-parcels-schema'
import { getWorldsHandler } from './handlers/worlds-handler'
import { reprocessABSchema } from './schemas/reprocess-ab-schemas'
import { getWorldScenesSchema } from './schemas/scenes-query-schemas'
import { worldCommsHandler } from './handlers/world-comms-handler'

export async function setupRouter(globalContext: GlobalContext): Promise<Router<GlobalContext>> {
  const { fetch, schemaValidator, config } = globalContext.components

  const signedFetchMiddleware = wellKnownComponents({
    fetcher: fetch,
    optional: false,
    metadataValidator: (metadata: Record<string, any>): boolean => metadata.signer !== 'decentraland-kernel-scene',
    onError: (err: any) => ({
      error: err.message,
      message: 'This endpoint requires a signed fetch request. See ADR-44.'
    })
  })

  const router = new Router<GlobalContext>()
  router.use(errorHandler)

  router.get('/world/:world_name/about', worldAboutHandler)

  // Post world scene(s)
  router.post('/entities', multipartParserWrapper(deployEntity))
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
  router.put('/world/:world_name/settings', signedFetchMiddleware, multipartParserWrapper(updateWorldSettingsHandler))

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
  router.post('/world/:world_name/permissions/:permission_name', signedFetchMiddleware, postPermissionsHandler)

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

  // Comms endpoints
  router.post('/worlds/:worldName/comms', signedFetchMiddleware, worldCommsHandler)
  router.post('/worlds/:worldName/scenes/:sceneId/comms', signedFetchMiddleware, worldCommsHandler)

  router.post('/get-comms-adapter/:roomId', signedFetchMiddleware, commsAdapterHandler)
  router.post('/cast-adapter/:roomId', signedFetchMiddleware, castAdapterHandler)

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
