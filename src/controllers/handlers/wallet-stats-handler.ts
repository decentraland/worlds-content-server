import { HandlerContextWithPath } from '../../types'

export async function walletStatsHandler({
  params,
  components: { walletStats }
}: Pick<HandlerContextWithPath<'config' | 'walletStats', '/wallet/:wallet/stats'>, 'components' | 'params' | 'url'>) {
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
      maxAllowedSpace: statsForWallet.maxAllowedSpace.toString()
    }
  }
}
