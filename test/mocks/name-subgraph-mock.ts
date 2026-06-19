import { ISubgraphComponent } from '@dcl/thegraph-component'

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
