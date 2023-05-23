// import * as ethers from 'ethers'
import { Contract, Provider } from 'ethers'
import { registrarAbi } from './abi'
import { Network } from './types'
import { EthAddress } from '@dcl/schemas'

export const registrarContracts = {
  goerli: '0x6b8da2752827cf926215b43bb8E46Fd7b9dDac35',
  mainnet: '0x2a187453064356c898cae034eaed119e1663acb8'
}

export async function getOwnerOf(dclName: string, network: Network, provider: Provider): Promise<EthAddress> {
  const contract = new Contract(registrarContracts[network], registrarAbi, provider)

  const ownerOf = await contract.getOwnerOf(dclName)

  return ownerOf.toLowerCase()
}
