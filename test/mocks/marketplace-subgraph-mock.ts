import { ISubgraphComponent } from '@well-known-components/thegraph-component'

export function createMockMarketplaceSubGraph(fixedResponse: any): ISubgraphComponent {
  return {
    query<T>(): Promise<T> {
      return Promise.resolve(fixedResponse)
    }
  }
}
