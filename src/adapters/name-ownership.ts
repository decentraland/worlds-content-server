import { AppComponents, INameOwnership } from '../types'
import { EthAddress } from '@dcl/schemas'
import {
  bytesToHex,
  ContractFactory,
  HTTPProvider,
  RequestManager,
  RPCSendableMessage,
  toBatchPayload,
  toData
} from 'eth-connect'
import { l1Contracts, L1Network, registrarAbi } from '@dcl/catalyst-contracts'
import namehash from '@ensdomains/eth-ens-namehash'
import { keccak_256 as keccak256 } from '@noble/hashes/sha3'
import { LRUCache } from 'lru-cache'

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

  async function findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>> {
    const [dclNameOwners, ensNameOwners] = await Promise.all([
      dclNameOwnership.findOwners(worldNames.filter((worldName) => worldName.endsWith('.dcl.eth'))),
      ensNameOwnership.findOwners(
        worldNames.filter((worldName) => worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth'))
      )
    ])

    const result = new LowerCaseKeysMap()
    for (const [worldName, owner] of dclNameOwners.entries()) {
      result.set(worldName, owner)
    }
    for (const [worldName, owner] of ensNameOwners.entries()) {
      result.set(worldName, owner)
    }

    logger.info(`Fetched owner of worlds: ${[...result.entries()].join(', ')}`)
    return result
  }

  return createCachingNameOwnership({ findOwners })
}

export async function createDummyNameOwnership(): Promise<INameOwnership> {
  async function findOwners(worldNames: string[]): Promise<Map<string, EthAddress | undefined>> {
    return new Map(worldNames.map((worldName) => [worldName, undefined]))
  }
  return {
    findOwners
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

  async function getOwnerOf(contract: { ownerOf: any }, names: string[]): Promise<(EthAddress | undefined)[]> {
    const batch: RPCSendableMessage[] = await Promise.all(names.map((name) => contract.ownerOf.toRPCMessage(name)))

    const result = await sendBatch(components.ethereumProvider, batch)
    return result.map((r: any) => {
      if (!r.result) {
        return undefined
      }
      return contract.ownerOf.unpackOutput(toData(r.result))?.toLowerCase()
    })
  }

  async function findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>> {
    const result = new LowerCaseKeysMap()
    const normalizedNames = worldNames.map((ensName) => namehash.normalize(ensName))

    const { twoLevelNames, otherNames } = normalizedNames.reduce(
      (acc, world) => {
        if (world.split('.').length === 2) {
          acc.twoLevelNames.push(world)
        } else {
          acc.otherNames.push(world)
        }
        return acc
      },
      { twoLevelNames: [] as string[], otherNames: [] as string[] }
    )

    // 2-level domains are direct registrations
    const labelNames = twoLevelNames.map((world) => world.split('.')[0]).map((labels) => getLabelHash(labels))
    if (labelNames.length > 0) {
      const fetched = await getOwnerOf(baseRegistrarImplementation, labelNames)
      for (const [i, _labelName] of labelNames.entries()) {
        const owner = fetched[i]
        if (!owner || owner !== ensContracts[ethNetwork].nameWrapper.toLowerCase()) {
          // The owner is not the NameWrapper contract, so return the owner
          result.set(twoLevelNames[i], owner)
        } else {
          // Get the owner from the NameWrapper contract
          otherNames.push(twoLevelNames[i])
        }
      }
    }

    const namehashes = otherNames.map((world) => namehash.hash(world))
    if (namehashes.length > 0) {
      const fetched = await getOwnerOf(nameWrapper, namehashes)
      for (const [i, _nameHash] of namehashes.entries()) {
        const owner = fetched[i]
        if (owner === '0x0000000000000000000000000000000000000000') {
          result.set(otherNames[i], undefined)
        } else {
          result.set(otherNames[i], owner)
        }
      }
    }

    return result
  }

  return {
    findOwners
  }
}

export async function createMarketplaceSubgraphDclNameOwnership(
  components: Pick<AppComponents, 'logs' | 'marketplaceSubGraph'>
): Promise<INameOwnership> {
  const logger = components.logs.getLogger('marketplace-subgraph-dcl-name-ownership')
  logger.info('Using Marketplace Subgraph NameOwnership')

  function getQueryFragment(worldName: string) {
    // We need to add a 'P' prefix because the graph needs the fragment name to start with a letter and
    // names can start with digits
    return `
      P${worldName}: nfts(
        where: {name_starts_with_nocase: "${worldName.toLowerCase()}", name_ends_with_nocase: "${worldName.toLowerCase()}", category: ens}
        orderBy: name
        first: 1000
      ) {
        name
        owner {
          id
        }
      }
    `
  }

  async function findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>> {
    const result = new LowerCaseKeysMap()
    /*
    DCL owners are case-sensitive, so when searching by dcl name in TheGraph we
    need to do a case-insensitive search because the worldName provided as fetch key
    may not be in the exact same case of the registered name. There are several methods
    suffixed _nocase, but not one for equality, so this is a bit hackish, but it works.
     */
    if (worldNames.length > 0) {
      const query = `{${worldNames.map((name) => getQueryFragment(name.replace('.dcl.eth', ''))).join('\n')}}`
      const response = await components.marketplaceSubGraph.query<NamesResponse>(query)

      const page = Object.entries(response).map(([dclNameWithPrefix, nfts]) => {
        return {
          dclName: dclNameWithPrefix.substring(1),
          owner:
            nfts
              .filter((nft) => `${nft.name.toLowerCase()}` === dclNameWithPrefix.substring(1).toLowerCase())
              .map((nameObj: { owner: { id: string } }) => nameObj.owner.id)[0] || undefined
        }
      })

      for (const record of page) {
        result.set(`${record.dclName}.dcl.eth`, record.owner)
      }
    }

    return result
  }

  return {
    findOwners
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

  async function getOwnerOf(names: string[]): Promise<(EthAddress | undefined)[]> {
    const batch: RPCSendableMessage[] = await Promise.all(
      names.map((name) => registrarContract.getOwnerOf.toRPCMessage(name))
    )

    const result = await sendBatch(components.ethereumProvider, batch)
    return result.map((r: any) => {
      if (!r.result) {
        return undefined
      }
      return registrarContract.getOwnerOf.unpackOutput(toData(r.result))
    })
  }

  async function findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>> {
    const result = new LowerCaseKeysMap()
    const fetched = await getOwnerOf(worldNames.map((worldName) => worldName.replace('.dcl.eth', '')))
    worldNames.forEach((worldName, i) => {
      const ownerOf = fetched[i]
      result.set(worldName, ownerOf)
    })

    return result
  }

  return {
    findOwners
  }
}

export async function createCachingNameOwnership(nameOwnership: INameOwnership): Promise<INameOwnership> {
  const cache = new LRUCache<string, EthAddress>({
    max: 100,
    ttl: 60 * 1000 // cache for 1 minute
  })

  async function findOwners(worldNames: string[]): Promise<ReadonlyMap<string, EthAddress | undefined>> {
    const result = new LowerCaseKeysMap()
    const needToFetch: string[] = []
    for (const worldName of worldNames) {
      const normalized = worldName.toLowerCase()
      if (cache.has(normalized)) {
        result.set(normalized, cache.get(normalized))
      } else {
        needToFetch.push(normalized)
      }
    }
    if (needToFetch.length > 0) {
      const fetched = await nameOwnership.findOwners(needToFetch)
      for (const [worldName, owner] of fetched.entries()) {
        result.set(worldName, owner)
        cache.set(worldName, owner)
      }
    }
    return result
  }

  return {
    findOwners
  }
}

function sendBatch(provider: HTTPProvider, batch: RPCSendableMessage[]) {
  const payload = toBatchPayload(batch)
  return new Promise<any>((resolve, reject) => {
    provider.sendAsync(payload as any, (err: any, result: any) => {
      if (err) {
        reject(err)
        return
      }

      resolve(result)
    })
  })
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

class LowerCaseKeysMap implements ReadonlyMap<string, EthAddress | undefined> {
  private readonly map: Map<string, EthAddress | undefined>

  constructor() {
    this.map = new Map()
  }

  forEach(
    callbackfn: (value: EthAddress | undefined, key: string, map: ReadonlyMap<string, EthAddress | undefined>) => void,
    thisArg?: any
  ): void {
    this.map.forEach(callbackfn, thisArg)
  }

  [Symbol.iterator](): IterableIterator<[string, EthAddress | undefined]> {
    return this.map[Symbol.iterator]()
  }

  set(key: string, value: EthAddress | undefined): void {
    this.map.set(key.toLowerCase(), value?.toLowerCase())
  }

  get(key: string): EthAddress | undefined {
    return this.map.get(key.toLowerCase())
  }

  has(key: string): boolean {
    return this.map.has(key.toLowerCase())
  }

  get size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[string, EthAddress | undefined]> {
    return this.map.entries()
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  values(): IterableIterator<EthAddress | undefined> {
    return this.map.values()
  }
}
