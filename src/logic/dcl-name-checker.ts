import { AppComponents, IDclNameChecker } from '../types'
import { EthAddress } from '@dcl/schemas'

type NamesResponse = {
  names: { name: string }[]
}

export const createDclNameChecker = (
  components: Pick<AppComponents, 'logs' | 'marketplaceSubGraph'>
): IDclNameChecker => {
  return {
    async fetchNamesOwnedByAddress(ethAddress: EthAddress): Promise<string[]> {
      const result = await components.marketplaceSubGraph.query<NamesResponse>(
        `
      query FetchNames($ethAddress: String) {
          names: nfts(where: { owner: $ethAddress, category: ens }, orderBy: name, first: 1000) {
            name
          }
       }`,
        {
          ethAddress: ethAddress.toLowerCase()
        }
      )

      const names = result.names.map(({ name }) => name)

      components.logs.getLogger('check-permissions').debug(`Fetched names for address ${ethAddress}: ${names}`)
      return names
    },

    determineDclNameToUse(names: string[], sceneJson: any): string {
      const worldSpecifiedName: string | undefined = sceneJson.metadata.worldConfiguration?.dclName
      return worldSpecifiedName?.substring(0, worldSpecifiedName?.length - 8) || names[0]
    }
  }
}
