import SQL, { SQLStatement } from 'sql-template-strings'
import { IPgComponent } from '@dcl/pg-component'
import { Query, withUploadTransaction } from '../../src/adapters/upload-transaction'
import { sqlText } from '../utils'

describe('when running an upload transaction', () => {
  let query: jest.Mock
  let release: jest.Mock
  let database: IPgComponent
  let controller: AbortController
  let operation: jest.Mock<Promise<string>, [Query]>
  let outcome: Promise<string>
  let issued: () => string[]

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    release = jest.fn()
    database = {
      getPool: () => ({ connect: async () => ({ query, release }) })
    } as unknown as IPgComponent
    controller = new AbortController()
    issued = () => query.mock.calls.map(([sql]) => sqlText(sql))
  })

  describe('and the operation succeeds', () => {
    let result: string

    beforeEach(async () => {
      operation = jest.fn(async (run: Query) => {
        await run(SQL`UPDATE uploads SET state = 'staged'`)
        return 'staged'
      })
      result = await withUploadTransaction(database, operation, controller.signal)
    })

    it('should return the operation result', () => {
      expect(result).toBe('staged')
    })

    it('should commit after the operation statements', () => {
      expect(issued()).toEqual([
        'BEGIN',
        expect.stringContaining('statement_timeout'),
        "UPDATE uploads SET state = 'staged'",
        'COMMIT'
      ])
    })

    it('should return the connection to the pool', () => {
      expect(release.mock.calls).toEqual([[]])
    })
  })

  describe('and the request is aborted while a statement runs', () => {
    let reason: Error

    beforeEach(async () => {
      reason = new Error('client disconnected')
      let failRunningStatement: (error: Error) => void = () => undefined
      release.mockImplementation(() => failRunningStatement(new Error('Connection terminated')))
      operation = jest.fn(async (run: Query) => {
        query.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              failRunningStatement = reject
              controller.abort(reason)
            })
        )
        await run(SQL`UPDATE uploads SET state = 'staged'`)
        return 'staged'
      })
      outcome = withUploadTransaction(database, operation, controller.signal)
      await outcome.catch(() => undefined)
    })

    it('should reject with the abort reason', async () => {
      await expect(outcome).rejects.toBe(reason)
    })

    it('should destroy the connection exactly once', () => {
      expect(release.mock.calls).toEqual([[true]])
    })

    it('should neither commit nor roll back', () => {
      expect(issued()).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(COMMIT|ROLLBACK)$/)]))
    })
  })

  describe('and a statement completes after the request was aborted', () => {
    let continuedAfterStatement: jest.Mock

    beforeEach(async () => {
      continuedAfterStatement = jest.fn()
      operation = jest.fn(async (run: Query) => {
        query.mockImplementationOnce(async () => {
          controller.abort(new Error('client disconnected'))
          return { rows: [], rowCount: 1 }
        })
        await run(SQL`UPDATE uploads SET state = 'staged'`)
        continuedAfterStatement()
        return 'staged'
      })
      await withUploadTransaction(database, operation, controller.signal).catch(() => undefined)
    })

    it('should not hand the result back to the operation', () => {
      expect(continuedAfterStatement).not.toHaveBeenCalled()
    })
  })

  describe('and the request is aborted after the operation resolves', () => {
    let reason: Error

    beforeEach(async () => {
      reason = new Error('deadline exceeded')
      operation = jest.fn(async (_run: Query) => {
        controller.abort(reason)
        return 'staged'
      })
      outcome = withUploadTransaction(database, operation, controller.signal)
      await outcome.catch(() => undefined)
    })

    it('should reject with the abort reason', async () => {
      await expect(outcome).rejects.toBe(reason)
    })

    it('should not commit', () => {
      expect(issued()).not.toContain('COMMIT')
    })

    it('should destroy the connection exactly once', () => {
      expect(release.mock.calls).toEqual([[true]])
    })
  })

  describe('and the operation fails', () => {
    let failure: Error

    beforeEach(async () => {
      failure = new Error('constraint violated')
      operation = jest.fn().mockRejectedValue(failure)
      outcome = withUploadTransaction(database, operation, controller.signal)
      await outcome.catch(() => undefined)
    })

    it('should reject with the operation error', async () => {
      await expect(outcome).rejects.toBe(failure)
    })

    it('should roll back as the last statement', () => {
      expect(issued().slice(-1)[0]).toBe('ROLLBACK')
    })

    it('should return the connection to the pool without destroying it', () => {
      expect(release.mock.calls).toEqual([[]])
    })
  })

  describe('and the operation fails and the rollback fails too', () => {
    let failure: Error

    beforeEach(async () => {
      failure = new Error('constraint violated')
      query.mockImplementation(async (sql: string | SQLStatement) => {
        if (sqlText(sql) === 'ROLLBACK') throw new Error('connection lost')
        return { rows: [], rowCount: 0 }
      })
      operation = jest.fn().mockRejectedValue(failure)
      outcome = withUploadTransaction(database, operation, controller.signal)
      await outcome.catch(() => undefined)
    })

    it('should rethrow the original operation error', async () => {
      await expect(outcome).rejects.toBe(failure)
    })

    it('should destroy the connection exactly once', () => {
      expect(release.mock.calls).toEqual([[true]])
    })
  })
})
