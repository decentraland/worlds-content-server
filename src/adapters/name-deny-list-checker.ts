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
    fetchMethod: async (_: string): Promise<string[]> => {
      if (url) {
        logger.info(`Fetching name deny list from ${url}`)
        const response = await components.fetch.fetch(`${url}/banned-names`, { method: 'POST' })
        const list = (await response.json())['data']
        logger.debug(`Fetched list: ${list}`)
        return list
      }
      return []
    }
  })

  const checkNameDenyList = async (worldName: string): Promise<boolean> => {
    const bannedNames = await nameDenyListCache.fetch(NAME_DENY_LIST_ENTRY)
    const isBanned = bannedNames?.includes(worldName.replace('.eth', '').replace('.dcl', ''))
    if (isBanned) {
      logger.warn(`Name ${worldName} is banned`)
    }

    return !isBanned
  }

  return {
    checkNameDenyList
  }
}
