import { IPgComponent } from '@well-known-components/pg-component'
import { IDatabase } from '@well-known-components/interfaces'
import { Pool } from 'pg'
import { SQLStatement } from 'sql-template-strings'

export function createDatabaseMock(queryResults: any[] = []): IPgComponent {
  let i = 0
  return {
    query<T extends Record<string, any>>(
      _sql: string | SQLStatement,
      _durationQueryNameLabel?: string
    ): Promise<IDatabase.IQueryResult<T>> {
      if (i >= queryResults.length) {
        throw new Error('No more queryResults mocked.')
      }
      return queryResults[i++]
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
}
