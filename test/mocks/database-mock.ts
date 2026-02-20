import { IPgComponent, QueryResult } from '@dcl/pg-component'
import { Pool, PoolClient } from 'pg'
import { SQLStatement } from 'sql-template-strings'

export function createDatabaseMock(queryResults: any[] = []): IPgComponent {
  let i = 0
  return {
    query<T extends Record<string, any>>(
      _sql: string | SQLStatement,
      _durationQueryNameLabel?: string
    ): Promise<QueryResult<T>> {
      if (i >= queryResults.length) {
        throw new Error('No more queryResults mocked.')
      }
      const result = queryResults[i++]
      return Promise.resolve({ ...result, notices: result?.notices ?? [] })
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
    },
    withTransaction<T>(_callback: (client: PoolClient) => Promise<T>): Promise<T> {
      throw new Error('Not mocked')
    },
    withAsyncContextTransaction<T>(callback: () => Promise<T>): Promise<T> {
      return callback()
    }
  }
}
