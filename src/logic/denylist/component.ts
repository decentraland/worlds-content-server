import { LRUCache } from 'lru-cache'
import { AppComponents } from '../../types'
import { IDenyListComponent } from './types'

const WALLET_DENYLIST_CACHE_KEY = 'WALLET_DENYLIST'
const ENTITY_DENYLIST_CACHE_KEY = 'ENTITY_DENYLIST'

export async function createDenyListComponent(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>
): Promise<IDenyListComponent> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('denylist-component')

  const denylistUrl = await config.requireString('DENYLIST_JSON_URL')
  const assetBundleRegistryUrl = await config.requireString('ASSET_BUNDLE_REGISTRY_URL')

  const walletDenylistCache = new LRUCache<string, Set<string>>({
    max: 1,
    ttl: 5 * 60 * 1000,
    fetchMethod: async (): Promise<Set<string>> => {
      try {
        const response = await fetch.fetch(denylistUrl)
        const data: { users: { wallet: string }[] } = await response.json()

        if (data?.users && Array.isArray(data.users)) {
          return new Set(data.users.map((user) => user.wallet.toLowerCase()))
        }

        throw Error('Did not get an array of users')
      } catch (error) {
        logger.warn(`Failed to fetch wallet denylist from ${denylistUrl}: ${error}`)
        return new Set()
      }
    }
  })

  const entityDenylistCache = new LRUCache<string, Set<string>>({
    max: 1,
    ttl: 5 * 60 * 1000,
    fetchMethod: async (): Promise<Set<string>> => {
      try {
        const response = await fetch.fetch(`${assetBundleRegistryUrl}/denylist`)
        const data: { entity_id: string }[] = await response.json()

        if (Array.isArray(data)) {
          return new Set(data.map((entry) => entry.entity_id.toLowerCase()))
        }

        throw Error('Did not get an array of denylist entries')
      } catch (error) {
        logger.warn(`Failed to fetch entity denylist from ${assetBundleRegistryUrl}/denylist: ${error}`)
        return new Set()
      }
    }
  })

  async function isWalletDenylisted(identity: string): Promise<boolean> {
    const denyList = await walletDenylistCache.fetch(WALLET_DENYLIST_CACHE_KEY)
    return denyList?.has(identity.toLowerCase()) ?? false
  }

  async function isEntityDenylisted(entityId: string): Promise<boolean> {
    const denyList = await entityDenylistCache.fetch(ENTITY_DENYLIST_CACHE_KEY)
    return denyList?.has(entityId.toLowerCase()) ?? false
  }

  return {
    isWalletDenylisted,
    isEntityDenylisted
  }
}
