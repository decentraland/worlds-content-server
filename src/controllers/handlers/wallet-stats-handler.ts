import { HandlerContextWithPath } from '../../types'
import { EthAddress } from '@dcl/schemas'
import { InvalidRequestError } from '@dcl/platform-server-commons'

export async function walletStatsHandler({
  params,
  components: { walletStats }
}: Pick<HandlerContextWithPath<'walletStats', '/wallet/:wallet/stats'>, 'components' | 'params' | 'url'>) {
  const wallet = params.wallet

  if (!wallet || !EthAddress.validate(wallet)) {
    throw new InvalidRequestError('Invalid request. Missing or invalid wallet in request url param.')
  }

  const statsForWallet = await walletStats.get(params.wallet)

  return {
    status: 200,
    body: {
      wallet: statsForWallet.wallet,
      dclNames: statsForWallet.dclNames.map((world) => ({
        name: world.name,
        size: world.size.toString()
      })),
      ensNames: statsForWallet.ensNames.map((world) => ({
        name: world.name,
        size: world.size.toString()
      })),
      usedSpace: statsForWallet.usedSpace.toString(),
      maxAllowedSpace: statsForWallet.maxAllowedSpace.toString(),
      blockedSince: statsForWallet.blockedSince?.toISOString()
    }
  }
}
