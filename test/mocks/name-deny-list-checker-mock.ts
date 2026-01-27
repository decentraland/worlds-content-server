import { INameDenyListChecker } from '../../src/types'

export function createMockNameDenyListChecker(names: string[] = []): INameDenyListChecker {
  const checkNameDenyList = async (worldName: string): Promise<boolean> => {
    return !names.includes(worldName.replace('.dcl.eth', ''))
  }

  const getBannedNames = async (): Promise<string[]> => {
    return names
  }

  return {
    checkNameDenyList,
    getBannedNames
  }
}
