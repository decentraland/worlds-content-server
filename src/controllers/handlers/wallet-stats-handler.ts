import { HandlerContextWithPath } from '../../types'
import { EthAddress } from '@dcl/schemas'

type IWalletStats = {
  wallet: EthAddress
  worldsDeployed: string[]
  usedSpace: number
  maxAllowedSpace: number
}

export async function walletStatsHandler({
  params,
  components: { config, status, worldsManager }
}: Pick<
  HandlerContextWithPath<'config' | 'nameDenyListChecker' | 'status' | 'worldsManager', '/wallet/:wallet/stats'>,
  'components' | 'params' | 'url'
>) {
  const body: IWalletStats = {
    wallet: params.wallet,
    worldsDeployed: [], // worlds,
    usedSpace: 0,
    maxAllowedSpace: 0
  }

  return {
    status: 200,
    body
  }
}
