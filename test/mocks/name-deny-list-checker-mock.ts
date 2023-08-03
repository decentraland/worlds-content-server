import { INameDenyListChecker } from '../../src/types'

export function createMockNameDenyListChecker(names: string[] = []): INameDenyListChecker {
  const checkNameDenyList = async (worldName: string): Promise<boolean> => {
    return !names.includes(worldName.replace('.dcl.eth', ''))
  }
  return {
    checkNameDenyList
  }
}
