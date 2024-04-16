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
  getPermissionsHandler,
  postPermissionsHandler,
  putPermissionsAddressHandler
} from './handlers/permissions-handlers'
import { walletStatsHandler } from './handlers/wallet-stats-handler'
import { undeployEntity } from './handlers/undeploy-entity-handler'
import { bearerTokenMiddleware, errorHandler } from '@dcl/platform-server-commons'
import { reprocessABHandler } from './handlers/reprocess-ab-handler'
import { garbageCollectionHandler } from './handlers/garbage-collection'

export async function setupRouter(globalContext: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()
  router.use(errorHandler)

  const signedFetchMiddleware = wellKnownComponents({
    fetcher: globalContext.components.fetch,
    optional: false,
    onError: (err) => ({ error: err.message, message: 'This endpoint requires a signed fetch request. See ADR-44.' })
  })

  router.get('/world/:world_name/about', worldAboutHandler)

  // creation
  router.post('/entities', multipartParserWrapper(deployEntity))
  router.delete('/entities/:world_name', signedFetchMiddleware, undeployEntity)
  router.get('/available-content', availableContentHandler)

  // consumption
  router.head('/ipfs/:hashId', headContentFile)
  router.get('/ipfs/:hashId', getContentFile)

  router.post('/entities/active', activeEntitiesHandler)
  router.head('/contents/:hashId', headContentFile)
  router.get('/contents/:hashId', getContentFile)

  router.get('/world/:world_name/permissions', getPermissionsHandler)
  router.post('/world/:world_name/permissions/:permission_name', signedFetchMiddleware, postPermissionsHandler)
  router.put(
    '/world/:world_name/permissions/:permission_name/:address',
    signedFetchMiddleware,
    putPermissionsAddressHandler
  )
  router.delete(
    '/world/:world_name/permissions/:permission_name/:address',
    signedFetchMiddleware,
    deletePermissionsAddressHandler
  )

  router.get('/wallet/:wallet/stats', walletStatsHandler)
  router.get('/status', statusHandler)

  router.get('/index', getIndexHandler)
  router.get('/live-data', getLiveDataHandler)

  router.post('/get-comms-adapter/:roomId', commsAdapterHandler)
  router.post('/cast-adapter/:roomId', castAdapterHandler)

  // administrative endpoints
  const secret = await globalContext.components.config.requireString('AUTH_SECRET')
  if (secret) {
    router.post('/reprocess-ab', bearerTokenMiddleware(secret), reprocessABHandler)
    router.post('/gc', bearerTokenMiddleware(secret), garbageCollectionHandler)
  }
  return router
}
