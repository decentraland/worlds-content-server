import { AppComponents, INameDenyListChecker } from '../types'
import { LRUCache } from 'lru-cache'

export async function createNameDenyListChecker(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch'>
): Promise<INameDenyListChecker> {
  const logger = components.logs.getLogger('name-deny-list-provider')
  const url = await components.config.getString('DCL_LISTS_URL')
  if (url) {
    logger.info(`Using name deny list from ${url}.`)
  } else {
    logger.info('No name deny list url provided.')
  }

  const NAME_DENY_LIST_ENTRY = 'NAME_DENY_LIST_ENTRY'
  const nameDenyListCache = new LRUCache<string, string[]>({
    max: 1,
    ttl: 60 * 60 * 1000, // cache for 1 hour
    allowStaleOnFetchRejection: true,
    fetchMethod: async (_: string): Promise<string[]> => {
      if (url) {
        try {
          logger.info(`Fetching name deny list from ${url}`)
          const response = await components.fetch.fetch(`${url}/banned-names`, { method: 'POST' })
          const list = (await response.json())['data']
          logger.debug(`Fetched list: ${list}`)
          // Guard against a malformed payload (missing/non-array data or null/non-string entries),
          // otherwise a null entry crashes consumers that call .toLowerCase()/.replace() on it.
          return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
        } catch (error) {
          logger.warn(`Failed to fetch name deny list from ${url}/banned-names: ${error}`)
          return []
        }
      }
      return []
    }
  })

  const checkNameDenyList = async (worldName: string): Promise<boolean> => {
    const bannedNames = await nameDenyListCache.fetch(NAME_DENY_LIST_ENTRY)
    // Compare case-insensitively, otherwise a banned name could be deployed by changing its case
    const normalizedName = worldName.toLowerCase().replace('.eth', '').replace('.dcl', '')
    const isBanned = bannedNames?.some((name) => name.toLowerCase() === normalizedName)
    if (isBanned) {
      logger.warn(`Name ${worldName} is banned`)
    }

    return !isBanned
  }

  const getBannedNames = async (): Promise<string[]> => {
    const bannedNames = await nameDenyListCache.fetch(NAME_DENY_LIST_ENTRY)
    return bannedNames?.map((name) => name.replace('.eth', '').replace('.dcl', '')) ?? []
  }

  return {
    checkNameDenyList,
    getBannedNames
  }
}
