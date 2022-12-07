import { EthAddress } from '@dcl/schemas'
import { IDclNameChecker } from '../src/types'

export function createMockDclNameChecker(): IDclNameChecker {
  return {
    determineDclNameToUse(_ethAddress: EthAddress, _sceneJson: any): Promise<string> {
      return Promise.resolve(undefined)
    },
    fetchNamesOwnedByAddress(_ethAddress: EthAddress): Promise<string[]> {
      return Promise.resolve([])
    }
  }
}
