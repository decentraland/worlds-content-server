import { AppComponents, IWorldNamePermissionChecker } from '../types'
import { EthAddress } from '@dcl/schemas'
import LRU from 'lru-cache'
import { ContractFactory, RequestManager } from 'eth-connect'
import { checkerAbi, l1Contracts, L1Network } from '@dcl/catalyst-contracts'
import { ISubgraphComponent } from '@well-known-components/thegraph-component'

export type NamesResponse = {
  nfts: { name: string; owner: { id: string } }[]
}

async function checkEnsOwner(ensSubgraph: ISubgraphComponent, ensName: string): Promise<EthAddress | undefined> {
  const result = await ensSubgraph.query<NamesResponse>(
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
  return owners.length > 0 ? owners[0] : undefined
}

async function checkDclNameOwner(ensSubgraph: ISubgraphComponent, worldName: string): Promise<EthAddress | undefined> {
  /*
  DCL owners are case-sensitive, so when searching by dcl name in TheGraph we
  need to do a case-insensitive search because the worldName provided as fetch key
  may not be in the exact same case of the registered name. There are several methods
  suffixed _nocase, but not one for equality, so this is a bit hackish, but it works.
   */
  const result = await ensSubgraph.query<NamesResponse>(
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

    { worldName: worldName.toLowerCase().replace('.dcl.eth', '') }
  )

  const owners = result.nfts
    .filter((nft) => `${nft.name.toLowerCase()}.dcl.eth` === worldName.toLowerCase())
    .map(({ owner }) => owner.id.toLowerCase())
  return owners.length > 0 ? owners[0] : undefined
}

export const createDclNameChecker = (
  components: Pick<AppComponents, 'ensSubGraph' | 'logs' | 'marketplaceSubGraph'>
): IWorldNamePermissionChecker => {
  const logger = components.logs.getLogger('check-permissions')
  logger.info('Using TheGraph DclNameChecker')

  const cache = new LRU<string, string | undefined>({
    max: 100,
    ttl: 5 * 60 * 1000, // cache for 5 minutes
    fetchMethod: async (worldName: string): Promise<string | undefined> => {
      const result =
        worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')
          ? await checkEnsOwner(components.ensSubGraph, worldName)
          : await checkDclNameOwner(components.marketplaceSubGraph, worldName)
      logger.info(`Fetched owner of world ${worldName}: ${result}`)
      return result
    }
  })

  const checkPermission = async (ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0) {
      return false
    }

    const owner = await cache.fetch(worldName)
    const hasPermission = !!owner && owner === ethAddress.toLowerCase()

    logger.debug(`Checking name ${worldName} for address ${ethAddress}: ${hasPermission}`)

    return hasPermission
  }

  return {
    checkPermission
  }
}

export const createOnChainDclNameChecker = async (
  components: Pick<AppComponents, 'config' | 'ensSubGraph' | 'logs' | 'ethereumProvider'>
): Promise<IWorldNamePermissionChecker> => {
  const logger = components.logs.getLogger('check-permissions')
  logger.info('Using OnChain DclNameChecker')
  const ethNetwork = await components.config.requireString('ETH_NETWORK')
  const contracts = l1Contracts[ethNetwork as L1Network]
  if (!contracts) {
    throw new Error(`Invalid ETH_NETWORK: ${ethNetwork}`)
  }
  const factory = new ContractFactory(new RequestManager(components.ethereumProvider), checkerAbi)
  const checker = (await factory.at(contracts.checker)) as any

  const checkPermission = async (ethAddress: EthAddress, worldName: string): Promise<boolean> => {
    if (worldName.length === 0 || !worldName.endsWith('.eth')) {
      return false
    }

    let hasPermission = false
    if (worldName.endsWith('.eth') && !worldName.endsWith('.dcl.eth')) {
      const owner = await checkEnsOwner(components.ensSubGraph, worldName)
      if (ethAddress.toLowerCase() === owner?.toLowerCase()) {
        hasPermission = true
      }
    } else {
      hasPermission = await checker.checkName(
        ethAddress,
        contracts.registrar,
        worldName.replace('.dcl.eth', ''),
        'latest'
      )
    }

    logger.debug(`Checking name ${worldName} for address ${ethAddress}: ${hasPermission}`)

    return hasPermission
  }

  return {
    checkPermission
  }
}
