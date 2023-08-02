import { AppComponents, INameDenyListChecker } from '../types'
import LRU from 'lru-cache'
import { ContractFactory, RequestManager } from 'eth-connect'
import { getNameDenylistFromContract, l1Contracts, L1Network, listAbi } from '@dcl/catalyst-contracts'

export async function createNameDenyListChecker(
  components: Pick<AppComponents, 'config' | 'logs' | 'ethereumProvider'>
): Promise<INameDenyListChecker> {
  const logger = components.logs.getLogger('name-deny-list-provider')
  const ethNetwork = await components.config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const nameDenyListFactory = new ContractFactory(new RequestManager(components.ethereumProvider), listAbi)
  const nameDenyList = (await nameDenyListFactory.at(contracts.nameDenylist)) as any

  const NAME_DENY_LIST_ENTRY = 'NAME_DENY_LIST_ENTRY'
  const nameDenyListCache = new LRU<string, string[]>({
    max: 1,
    ttl: 6 * 60 * 60 * 1000, // cache for 6 hours
    fetchMethod: async (_: string): Promise<string[]> => {
      logger.info(`Fetching name deny list from contract ${contracts.nameDenylist}`)
      const list = await getNameDenylistFromContract(nameDenyList)
      logger.debug(`Fetched list: ${list}`)
      return list
    }
  })

  const checkNameDenyList = async (worldName: string): Promise<boolean> => {
    const bannedNames = await nameDenyListCache.fetch(NAME_DENY_LIST_ENTRY)
    const isBanned = bannedNames.includes(worldName.replace('.dcl.eth', ''))
    if (isBanned) {
      logger.warn(`Name ${worldName} is banned`)
    }

    return !isBanned
  }

  return {
    checkNameDenyList
  }
}
