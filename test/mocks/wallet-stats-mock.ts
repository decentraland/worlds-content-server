import { ClearBlockedResult, IWalletStats, WalletStats } from '../../src/types'
import { EthAddress } from '@dcl/schemas'

export function createMockWalletStatsComponent(responses: Map<EthAddress, WalletStats> = new Map()): IWalletStats {
  return {
    async get(wallet: EthAddress): Promise<WalletStats> {
      return responses.get(wallet)
    },
    async clearBlockedIfUnderQuota(wallet: EthAddress): Promise<ClearBlockedResult> {
      const stats = responses.get(wallet)
      if (stats?.blockedSince && stats.usedSpace <= stats.maxAllowedSpace) {
        const updated = { ...stats, blockedSince: undefined }
        return { unblocked: true, stats: updated }
      }
      return { unblocked: false, stats }
    }
  }
}
