import { IWalletStats, WalletStats } from '../../src/types'
import { EthAddress } from '@dcl/schemas'

export function createMockWalletStatsComponent(responses: Map<EthAddress, WalletStats> = new Map()): IWalletStats {
  return {
    async get(wallet: EthAddress): Promise<WalletStats> {
      return responses.get(wallet)
    }
  }
}
