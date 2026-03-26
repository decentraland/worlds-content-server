import { IPgComponent, QueryResult } from '@dcl/pg-component'
import { Pool, PoolClient } from 'pg'
import { SQLStatement } from 'sql-template-strings'

export function createDatabaseMock(queryResults: any[] = []): IPgComponent {
  let i = 0
  const mock: IPgComponent = {
    query<T extends Record<string, any>>(
      _sql: string | SQLStatement,
      _durationQueryNameLabel?: string
    ): Promise<QueryResult<T>> {
      if (i >= queryResults.length) {
        throw new Error('No more queryResults mocked.')
      }
      return queryResults[i++]
    },
    async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
      const mockClient = { query: (sql: any) => mock.query(sql) } as unknown as PoolClient
      return callback(mockClient)
    },
    async withAsyncContextTransaction<T>(callback: () => Promise<T>): Promise<T> {
      return callback()
    },
    getPool(): Pool {
      return undefined
    },
    start(): Promise<void> {
      return Promise.resolve(undefined)
    },
    stop(): Promise<void> {
      return Promise.resolve(undefined)
    },
    streamQuery<T = any>(_sql: SQLStatement, _config?: { batchSize?: number }): AsyncGenerator<T> {
      return undefined
    }
  }
  return mock
}
