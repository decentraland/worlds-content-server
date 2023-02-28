import { AppComponents, IDclNameChecker } from '../types'
import { EthAddress } from '@dcl/schemas'
import LRU from 'lru-cache'
import { ContractFactory, HTTPProvider, RequestManager } from 'eth-connect'
import { checkerAbi, checkerContracts, registrarContracts } from '@dcl/catalyst-contracts'
import { createSubgraphComponent } from '@well-known-components/thegraph-component'

type NamesResponse = {
  nfts: { name: string; owner: { id: string } }[]
}

export async function createDclNameChecker(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'metrics'>
): Promise<IDclNameChecker> {
  const logger = components.logs.getLogger('dcl-name checker')
  const nameValidatorStrategy = await components.config.requireString('NAME_VALIDATOR')
  switch (nameValidatorStrategy) {
    case 'THE_GRAPH_DCL_NAME_CHECKER':
      logger.info('Using TheGraph DclNameChecker')
      return createTheGraphDclNameChecker(components)
    case 'ON_CHAIN_DCL_NAME_CHECKER':
      logger.info('Using OnChain DclNameChecker')
      return await createOnChainDclNameChecker(components)
  }
  logger.info('No support for DCL name checking')
  return await createNoOwnershipSupportedNameChecker()
}

export async function createTheGraphDclNameChecker(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'metrics'>
): Promise<IDclNameChecker> {
  const logger = components.logs.getLogger('dcl-name checker')

  const subGraphUrl = await components.config.requireString('MARKETPLACE_SUBGRAPH_URL')
  const marketplaceSubGraph = await createSubgraphComponent(components, subGraphUrl)

  const cache = new LRU<string, string | undefined>({
    max: 100,
    ttl: 5 * 60 * 1000, // cache for 5 minutes
    fetchMethod: async (worldName: string): Promise<string | undefined> => {
      /*
      DCL owners are case-sensitive, so when searching by dcl name in TheGraph we
      need to do a case-insensitive search because the worldName provided as fetch key
      may not be in the exact same case of the registered name. There are several methods
      suffixed _nocase, but not one for equality, so this is a bit hackish, but it works.
       */
      const result = await marketplaceSubGraph.query<NamesResponse>(
        `
        query FetchOwnerForDclName($worldName: String) {
          nfts(
            where: {name_starts_with_nocase: $worldName, name_ends_with_nocase: $worldName, category: ens}
            orderBy: name
            first: 1000
          ) {
            name
            owner {
              id
            }
          }
        }`,
        {
          worldName: worldName.toLowerCase().replace('.dcl.eth', '')
        }
      )
      logger.info(`Fetched owner of world ${worldName}: ${result.nfts.map(({ owner }) => owner.id.toLowerCase())}`)

      const owners = result.nfts
        .filter((nft) => `${nft.name.toLowerCase()}.dcl.eth` === worldName.toLowerCase())
        .map(({ owner }) => owner.id.toLowerCase())

      return owners.length > 0 ? owners[0] : undefined
    }
  })

  async function checkOwnership(ethAddress: EthAddress, worldName: string): Promise<boolean> {
    if (worldName.length === 0) {
      return false
    }

    const owner = await cache.fetch(worldName)
    return !!owner && owner === ethAddress.toLowerCase()
  }

  return {
    checkOwnership
  }
}

export async function createOnChainDclNameChecker(
  components: Pick<AppComponents, 'config' | 'logs' | 'fetch'>
): Promise<IDclNameChecker> {
  const logger = components.logs.getLogger('dcl-name checker')

  const rpcUrl = await components.config.requireString('RPC_URL')
  const ethereumProvider = new HTTPProvider(rpcUrl, components.fetch)
  const networkId = await components.config.requireString('NETWORK_ID')
  const networkName = networkId === '1' ? 'mainnet' : 'goerli'
  const factory = new ContractFactory(new RequestManager(ethereumProvider), checkerAbi)
  const checker = (await factory.at(checkerContracts[networkName])) as any

  async function checkOwnership(ethAddress: EthAddress, worldName: string): Promise<boolean> {
    if (worldName.length === 0 || !worldName.endsWith('.dcl.eth')) {
      return false
    }

    const hasPermission = await checker.checkName(
      ethAddress,
      registrarContracts[networkName],
      worldName.replace('.dcl.eth', ''),
      'latest'
    )

    logger.debug(`Checking name ${worldName} for address ${ethAddress}: ${hasPermission}`)

    return hasPermission
  }

  return {
    checkOwnership
  }
}

export async function createNoOwnershipSupportedNameChecker(): Promise<IDclNameChecker> {
  async function checkOwnership(_ethAddress: EthAddress, _worldName: string): Promise<boolean> {
    return false
  }

  return {
    checkOwnership
  }
}
