import { INameOwnership } from '../../src/types'
import { EthAddress } from '@dcl/schemas'

export function createMockNameOwnership(values: Map<string, EthAddress> = new Map()): INameOwnership {
  return {
    async findOwner(worldName: string): Promise<EthAddress | undefined> {
      return values.get(worldName)
    }
  }
}
