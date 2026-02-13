import { LRUCache } from 'lru-cache'
import { AppComponents } from '../../types'
import { IDenyListComponent } from './types'

const DENYLIST_CACHE_KEY = 'DENYLIST'

/**
 * Creates the DenyList component.
 *
 * Fetches and caches the global denylist of wallet addresses from an external URL.
 * Uses LRU cache with a 5-minute TTL to avoid fetching on every request.
 *
 * @param components Required components: config, fetch, logs
 * @returns IDenyListComponent implementation
 */
export async function createDenyListComponent(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>
): Promise<IDenyListComponent> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('denylist-component')

  const denylistUrl = await config.requireString('DENYLIST_JSON_URL')

  const denylistCache = new LRUCache<string, Set<string>>({
    max: 1,
    ttl: 5 * 60 * 1000, // cache for 5 minutes
    fetchMethod: async (): Promise<Set<string>> => {
      try {
        const response = await fetch.fetch(denylistUrl)
        const data: { users: { wallet: string }[] } = await response.json()

        if (data?.users && Array.isArray(data.users)) {
          return new Set(data.users.map((user) => user.wallet.toLowerCase()))
        }

        throw Error('Did not get an array of users')
      } catch (error) {
        logger.warn(`Failed to fetch denylist from ${denylistUrl}: ${error}`)
        return new Set()
      }
    }
  })

  /**
   * Checks if the given identity (wallet address) is in the global denylist.
   *
   * @param identity - The wallet address to check.
   * @returns True if the identity is denylisted, false otherwise.
   */
  async function isDenylisted(identity: string): Promise<boolean> {
    const denyList = await denylistCache.fetch(DENYLIST_CACHE_KEY)
    return denyList?.has(identity.toLowerCase()) ?? false
  }

  return {
    isDenylisted
  }
}
