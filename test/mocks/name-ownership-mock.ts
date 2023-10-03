import { INameOwnership } from '../../src/types'
import { EthAddress } from '@dcl/schemas'

export function createMockNameOwnership(values: Map<string, EthAddress> = new Map()): INameOwnership {
  return {
    async findOwners(worldNames: string[]): Promise<Map<string, EthAddress | undefined>> {
      const result = new Map<string, EthAddress | undefined>()
      worldNames.forEach((worldName) => result.set(worldName, values.get(worldName)))
      return result
    }
  }
}
