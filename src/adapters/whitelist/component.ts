import { LRUCache } from 'lru-cache'
import { AppComponents, Whitelist } from '../../types'
import { errorMessage } from '../../logic/utils'
import { IWhitelistComponent } from './types'

const CACHE_KEY = 'whitelist'
const CACHE_TTL_MS = 10 * 60 * 1000

export async function createWhitelistComponent(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>
): Promise<IWhitelistComponent> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('whitelist')
  const whitelistUrl = await config.requireString('WHITELIST_URL')

  // Cache the whitelist for a short period. On a fetch failure the cache keeps serving the last
  // known value (allowStaleOnFetchRejection + noDeleteOnFetchRejection); only when there is no
  // cached value at all does get() reject, so each caller can decide how to degrade rather than
  // silently proceeding with an empty whitelist.
  const cache = new LRUCache<string, Whitelist>({
    max: 1,
    ttl: CACHE_TTL_MS,
    allowStale: true,
    noDeleteOnFetchRejection: true,
    allowStaleOnFetchRejection: true,
    fetchMethod: async () => {
      try {
        const response = await fetch.fetch(whitelistUrl)
        return (await response.json()) as unknown as Whitelist
      } catch (error) {
        logger.warn(`Error fetching the whitelist: ${errorMessage(error)}.`)
        throw error
      }
    }
  })

  async function get(): Promise<Whitelist> {
    // cache.fetch resolves the fresh value, or the stale value when a refresh fails but a
    // previous value exists (allowStaleOnFetchRejection). It resolves undefined only when the
    // fetch failed and there is nothing cached to fall back to — surface that as an error so
    // callers don't mistake an outage for an empty whitelist.
    const whitelist = await cache.fetch(CACHE_KEY)
    if (whitelist === undefined) {
      throw new Error('The whitelist could not be fetched and no cached value is available')
    }
    return whitelist
  }

  return {
    get
  }
}
