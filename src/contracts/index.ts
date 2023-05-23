// import * as ethers from 'ethers'
import { Contract, Provider } from 'ethers'
import { landAbi, registrarAbi } from './abi'
import { Network } from './types'
import { EthAddress } from '@dcl/schemas'

export const registrarContracts = {
  goerli: '0x6b8da2752827cf926215b43bb8E46Fd7b9dDac35',
  mainnet: '0x2a187453064356c898cae034eaed119e1663acb8'
}

export const landContracts = {
  goerli: '0x25b6B4bac4aDB582a0ABd475439dA6730777Fbf7',
  mainnet: '0xf87e31492faf9a91b02ee0deaad50d51d56d5d4d'
}

export async function getOwnerOf(dclName: string, network: Network, provider: Provider): Promise<EthAddress> {
  const contract = new Contract(registrarContracts[network], registrarAbi, provider)

  const ownerOf = await contract.getOwnerOf(dclName)

  return ownerOf.toLowerCase()
}

export async function balanceOf(owner: EthAddress, network: Network, provider: Provider): Promise<number> {
  const contract = new Contract(landContracts[network], landAbi, provider)
  console.log(landContracts[network], owner)
  console.log(contract.balanceOf)
  // TODO Hugo failing
  return await contract.balanceOf(owner)
}
