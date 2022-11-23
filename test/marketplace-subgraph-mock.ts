import { ISubgraphComponent, Variables } from '@well-known-components/thegraph-component'

export function createMockMarketplaceSubGraph(): ISubgraphComponent {
  return {
    query<T>(query: string, variables: Variables | undefined, remainingAttempts: number | undefined): Promise<T> {
      return Promise.resolve({
        names: []
      } as T)
    }
  }
}
