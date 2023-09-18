import { AppComponents, INameOwnership } from '../types'
import { EthAddress } from '@dcl/schemas'
import { ContractFactory, RequestManager } from 'eth-connect'
import { l1Contracts, L1Network, registrarAbi } from '@dcl/catalyst-contracts'
import LRU from 'lru-cache'
import { createSubgraphComponent } from '@well-known-components/thegraph-component'

type NamesResponse = {
  nfts: { name: string; owner: { id: string } }[]
}

async function createDclNameOwnership(
  components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'logs' | 'marketplaceSubGraph'>
) {
  const nameValidatorStrategy = await components.config.requireString('NAME_VALIDATOR')
  switch (nameValidatorStrategy) {
    case 'DCL_NAME_CHECKER':
      return createMarketplaceSubgraphDclNameOwnership(components)
    case 'ON_CHAIN_DCL_NAME_CHECKER':
      return await createOnChainDclNameOwnership(components)

    // Add more name validator strategies as needed here
  }
  throw Error(`Invalid nameValidatorStrategy selected: ${nameValidatorStrategy}`)
}

export async function createNameOwnership(
  components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'fetch' | 'logs' | 'marketplaceSubGraph' | 'metrics'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('name-ownership')
  logger.info('Using NameOwnership')

  const ensNameOwnership = await createEnsNameOwnership(components)
  const dclNameOwnership = await createDclNameOwnership(components)

  async function findOwner(worldName: string): Promise<EthAddress | undefined> {
    const result =
      worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')
        ? await ensNameOwnership.findOwner(worldName)
        : await dclNameOwnership.findOwner(worldName)
    logger.info(`Fetched owner of world ${worldName}: ${result}`)
    return result
  }

  return createCachingNameOwnership({ findOwner })
}

export async function createDummyNameOwnership(): Promise<INameOwnership> {
  async function findOwner() {
    return undefined
  }
  return {
    findOwner
  }
}

export async function createEnsNameOwnership(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs' | 'metrics'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('ens-name-ownership')
  logger.info('Using ENS NameOwnership')

  const ensSubgraphUrl = await components.config.getString('ENS_SUBGRAPH_URL')
  if (!ensSubgraphUrl) {
    return await createDummyNameOwnership()
  }

  const ensSubGraph = await createSubgraphComponent(components, ensSubgraphUrl)
  async function findOwner(ensName: string): Promise<EthAddress | undefined> {
    const result = await ensSubGraph.query<NamesResponse>(
      `query FetchOwnerForEnsName($ensName: String) {
      nfts: domains(where: {name_in: [$ensName]}) {
        name
        owner {
          id
        }
      }
    }`,
      { ensName }
    )

    const owners = result.nfts.map(({ owner }) => owner.id.toLowerCase())
    const owner = owners.length > 0 ? owners[0] : undefined

    logger.debug(`Owner of ENS name '${ensName}' is ${owner}`)

    return owner
  }

  return {
    findOwner
  }
}

export async function createMarketplaceSubgraphDclNameOwnership(
  components: Pick<AppComponents, 'logs' | 'marketplaceSubGraph'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('marketplace-subgraph-dcl-name-ownership')
  logger.info('Using Marketplace Subgraph NameOwnership')

  async function findOwner(dclName: string): Promise<EthAddress | undefined> {
    /*
    DCL owners are case-sensitive, so when searching by dcl name in TheGraph we
    need to do a case-insensitive search because the worldName provided as fetch key
    may not be in the exact same case of the registered name. There are several methods
    suffixed _nocase, but not one for equality, so this is a bit hackish, but it works.
     */
    const result = await components.marketplaceSubGraph.query<NamesResponse>(
      `query FetchOwnerForDclName($worldName: String) {
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

      { worldName: dclName.toLowerCase().replace('.dcl.eth', '') }
    )

    const owners = result.nfts
      .filter((nft) => `${nft.name.toLowerCase()}.dcl.eth` === dclName.toLowerCase())
      .map(({ owner }) => owner.id.toLowerCase())
    return owners.length > 0 ? owners[0] : undefined
  }

  return {
    findOwner
  }
}

export async function createOnChainDclNameOwnership(
  components: Pick<AppComponents, 'config' | 'logs' | 'ethereumProvider'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('on-chain-dcl-name-ownership')
  logger.info('Using OnChain DCL NameOwnership')

  const ethNetwork = (await components.config.requireString('ETH_NETWORK')) as L1Network
  const contracts = l1Contracts[ethNetwork]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }
  const requestManager = new RequestManager(components.ethereumProvider)
  const registrarAddress = l1Contracts[ethNetwork].registrar
  const factory = new ContractFactory(requestManager, registrarAbi)
  const registrarContract = (await factory.at(registrarAddress)) as any

  async function findOwner(dclName: string): Promise<EthAddress | undefined> {
    try {
      const owner = await registrarContract.getOwnerOf(dclName.replace('.dcl.eth', ''))
      logger.debug(`Owner of DCL name '${dclName}' is ${owner}`)
      return owner
    } catch (e) {
      return undefined
    }
  }

  return {
    findOwner
  }
}

export async function createCachingNameOwnership(nameOwnership: INameOwnership): Promise<INameOwnership> {
  const cache = new LRU<string, EthAddress | undefined>({
    max: 100,
    ttl: 60 * 1000, // cache for 1 minute
    fetchMethod: async (worldName: string): Promise<string | undefined> => {
      return await nameOwnership.findOwner(worldName)
    }
  })

  async function findOwner(name: string): Promise<EthAddress | undefined> {
    return await cache.fetch(name)
  }

  return {
    findOwner
  }
}
