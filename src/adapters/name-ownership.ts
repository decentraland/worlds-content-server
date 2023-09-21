import { AppComponents, INameOwnership } from '../types'
import { EthAddress } from '@dcl/schemas'
import { bytesToHex, ContractFactory, RequestManager } from 'eth-connect'
import { l1Contracts, L1Network, registrarAbi } from '@dcl/catalyst-contracts'
import LRU from 'lru-cache'
import namehash from '@ensdomains/eth-ens-namehash'
import { keccak_256 as keccak256 } from '@noble/hashes/sha3'

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
  components: Pick<AppComponents, 'config' | 'ethereumProvider' | 'logs' | 'marketplaceSubGraph'>
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
  components: Pick<AppComponents, 'config' | 'logs' | 'ethereumProvider'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('ens-name-ownership')
  logger.info('Using ENS NameOwnership')

  const allowEnsDomains = (await components.config.getString('ALLOW_ENS_DOMAINS')) === 'true'
  if (!allowEnsDomains) {
    return await createDummyNameOwnership()
  }

  const ethNetwork = (await components.config.requireString('ETH_NETWORK')) as L1Network
  const contracts = l1Contracts[ethNetwork]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }

  const requestManager = new RequestManager(components.ethereumProvider)
  const baseRegistrarImplementationFactory = new ContractFactory(requestManager, baseRegistrarImplementationAbi)
  const baseRegistrarImplementation = (await baseRegistrarImplementationFactory.at(
    ensContracts[ethNetwork].baseRegistrarImplementation
  )) as any

  const nameWrapperImplementationFactory = new ContractFactory(requestManager, nameWrapperAbi)
  const nameWrapper = (await nameWrapperImplementationFactory.at(ensContracts[ethNetwork].nameWrapper)) as any

  function getLabelHash(input: string) {
    return '0x' + bytesToHex(keccak256(input))
  }

  async function findOwner(ensName: string): Promise<EthAddress | undefined> {
    const normalized = namehash.normalize(ensName)
    const labels = normalized.split('.')
    if (labels.length === 2) {
      // It's a 2-level domain, so it's a direct registration
      const labelName = getLabelHash(labels[0])
      try {
        const ownerOfNft = await baseRegistrarImplementation.ownerOf(labelName)
        if (ownerOfNft.toLowerCase() !== ensContracts[ethNetwork].nameWrapper.toLowerCase()) {
          // The owner is not the NameWrapper contract, so return the owner
          return ownerOfNft.toLowerCase()
        }
      } catch (_) {
        return undefined
      }
    }

    // Check with the NameWrapper contract. This could validate domains with more than 2 levels.
    const ownerOfName = await nameWrapper.ownerOf(namehash.hash(ensName))
    if (ownerOfName === '0x0000000000000000000000000000000000000000') {
      return undefined
    }
    return ownerOfName.toLowerCase()
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
      return (await registrarContract.getOwnerOf(dclName.replace('.dcl.eth', ''))).toLowerCase()
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

// baseRegistrarImplementation has the same address in all networks:
// https://github.com/ensdomains/ens-subgraph/blob/master/networks.json#L60
const ensContracts: Record<L1Network, { baseRegistrarImplementation: string; nameWrapper: string }> = {
  mainnet: {
    baseRegistrarImplementation: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    nameWrapper: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401'
  },
  sepolia: {
    baseRegistrarImplementation: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8'
  },
  goerli: {
    baseRegistrarImplementation: '',
    nameWrapper: ''
  }
}

const baseRegistrarImplementationAbi = [
  {
    constant: true,
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  }
]

const nameWrapperAbi = [
  {
    inputs: [{ internalType: 'uint256', name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  }
]
