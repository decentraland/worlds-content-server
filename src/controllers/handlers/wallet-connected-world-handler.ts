import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import { NotFoundError } from '@dcl/http-commons'
import { LRUCache } from 'lru-cache'
import { fetchPulsePeerRealm, isWorldRealm } from '../../logic/pulse'

/**
 * This route is public, unauthenticated and unthrottled (`src/controllers/routes.ts`), so without a
 * cache every request would be one more `GET /peers/:id` against the service that is the platform's
 * single presence source. A very short TTL bounds that to one call per wallet per window while
 * staying live enough for the explorer, which only needs to see a teleport within a few seconds.
 */
const PULSE_PEER_CACHE_TTL_MS = 5 * 1000

/** `undefined` world = Pulse knows no world for that peer; that answer is worth caching too. */
type CachedConnectedWorld = { world: string | undefined }

type PulseLookup = { fetch: IFetchComponent; pulseUrl: string }

const connectedWorldCache = new LRUCache<string, CachedConnectedWorld, PulseLookup>({
  // Bounded so a scraper walking random addresses cannot grow the process heap.
  max: 10_000,
  ttl: PULSE_PEER_CACHE_TTL_MS,
  fetchMethod: async (wallet, _staleValue, { context }): Promise<CachedConnectedWorld> => {
    // A peer is "in a world" only when its Pulse realm is a world name; Genesis City is not a world.
    const realm = await fetchPulsePeerRealm(context.fetch, context.pulseUrl, wallet)
    return { world: realm && isWorldRealm(realm) ? realm : undefined }
  }
})

/**
 * Test seam: the cache above is module state, so a spec that asks for the same wallet in two cases
 * has to start each one from an empty cache.
 */
export function clearConnectedWorldCache(): void {
  connectedWorldCache.clear()
}

/**
 * @deprecated Iteration 2 replaces this route with Pulse's `GET /peers/:id`. It is kept for one
 * release while unity-explorer still calls it, and removed once the explorer reads Pulse directly.
 */
export async function walletConnectedWorldHandler(
  ctx: HandlerContextWithPath<'config' | 'fetch', '/wallet/:wallet/connected-world'> & DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, fetch },
    params
  } = ctx

  const { wallet } = params
  const pulseUrl = await config.requireString('PULSE_URL')

  let world: string | undefined
  try {
    world = await getConnectedWorldFromPulse(fetch, pulseUrl, wallet)
  } catch (error: any) {
    return { status: 503, body: { error: 'Service Unavailable', message: error.message } }
  }

  if (!world) {
    throw new NotFoundError(`Wallet ${wallet} is not connected to any world`)
  }

  return {
    status: 200,
    body: {
      wallet,
      world
    }
  }
}

async function getConnectedWorldFromPulse(
  fetch: IFetchComponent,
  pulseUrl: string,
  wallet: string
): Promise<string | undefined> {
  // Pulse stores addresses lowercased (the pack pins `0x…00AB` ingesting as `0x…00ab`), so the route
  // is case-insensitive on the wallet: an EIP-55 checksummed address must not 404 just because it is
  // not the spelling Pulse stores.
  const cached = await connectedWorldCache.fetch(wallet.toLowerCase(), { context: { fetch, pulseUrl } })
  return cached?.world
}
