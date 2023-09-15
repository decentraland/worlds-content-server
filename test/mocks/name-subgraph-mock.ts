import { ISubgraphComponent } from '@well-known-components/thegraph-component'

export function createMockNameSubGraph(
  fixedResponse: any = {
    nfts: []
  }
): ISubgraphComponent {
  return {
    query<T>(): Promise<T> {
      return Promise.resolve(fixedResponse)
    }
  }
}
