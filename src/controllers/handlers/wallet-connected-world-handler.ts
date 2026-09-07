import { DecentralandSignatureContext } from '@dcl/crypto-middleware'
import { HandlerContextWithPath } from '../../types'
import { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import { NotFoundError } from '@dcl/http-commons'
import { LRUCache } from 'lru-cache'
import { fetchPulsePeerRealm, getPresenceSource, isWorldRealm } from '../../logic/presence-source'

/**
 * This route is public, unauthenticated and unthrottled (`src/controllers/routes.ts`). On the
 * LiveKit source it answers from an in-memory `Map`, so a client polling it at N rps costs nothing;
 * on the Pulse source every request would otherwise be one more `GET /peers/:id` against the
 * service that is *becoming* the platform's single presence source. A very short TTL bounds that to
 * one call per wallet per window while staying live enough for the explorer, which only needs to
 * see a teleport within a few seconds.
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
  ctx: HandlerContextWithPath<'config' | 'fetch' | 'peersRegistry', '/wallet/:wallet/connected-world'> &
    DecentralandSignatureContext<any>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { config, fetch, peersRegistry },
    params
  } = ctx

  const { wallet } = params

  // `both` keeps serving the LiveKit-fed answer: the shadow comparison of the dual-source window is
  // scoped to the `/live-data` counters, this route is only read by the explorer. The registry
  // answer is never cached — it is already an in-memory `Map`, so caching would only add staleness.
  const world =
    (await getPresenceSource(config)) === 'pulse'
      ? await getConnectedWorldFromPulse(fetch, await config.requireString('PULSE_URL'), wallet)
      : peersRegistry.getPeerWorld(wallet)

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
  // Pulse stores addresses lowercased (the pack pins `0x…00AB` ingesting as `0x…00ab`) and the
  // registry path lowercases the id too, so the route is case-insensitive on the wallet today. An
  // EIP-55 checksummed address must not start 404ing just because the source swapped.
  const cached = await connectedWorldCache.fetch(wallet.toLowerCase(), { context: { fetch, pulseUrl } })
  return cached?.world
}
