import { connectWithSignal, PgClient } from '../../src/adapters/pg-client'

describe('when connecting a pool client with a signal', () => {
  let client: PgClient
  let release: jest.Mock
  let connect: jest.Mock
  let controller: AbortController

  beforeEach(() => {
    release = jest.fn()
    client = { query: jest.fn(), release, on: jest.fn(), removeListener: jest.fn() }
    controller = new AbortController()
  })

  describe('and the pool hands out a client before the signal aborts', () => {
    let result: PgClient

    beforeEach(async () => {
      connect = jest.fn().mockResolvedValue(client)
      result = await connectWithSignal({ connect }, controller.signal)
    })

    it('should return the client without releasing it', () => {
      expect({ result, releases: release.mock.calls.length }).toEqual({ result: client, releases: 0 })
    })
  })

  describe('and the signal is already aborted', () => {
    let caughtError: unknown
    let reason: Error

    beforeEach(async () => {
      reason = new Error('aborted')
      connect = jest.fn().mockResolvedValue(client)
      controller.abort(reason)
      caughtError = await connectWithSignal({ connect }, controller.signal).catch((error: unknown) => error)
    })

    it('should reject with the abort reason without checking out a client', () => {
      expect({ caughtError, connects: connect.mock.calls.length }).toEqual({ caughtError: reason, connects: 0 })
    })
  })

  describe('and the signal aborts while the pool is still connecting', () => {
    let caughtError: unknown
    let reason: Error
    let resolveConnect: (client: PgClient) => void

    beforeEach(async () => {
      reason = new Error('aborted')
      connect = jest.fn(
        () =>
          new Promise<PgClient>((resolve) => {
            resolveConnect = resolve
          })
      )
      const pending = connectWithSignal({ connect }, controller.signal).catch((error: unknown) => error)
      controller.abort(reason)
      caughtError = await pending
      resolveConnect(client)
      await new Promise((resolve) => setImmediate(resolve))
    })

    it('should reject with the abort reason and release the late client', () => {
      expect({ caughtError, releases: release.mock.calls }).toEqual({ caughtError: reason, releases: [[]] })
    })
  })

  describe('and the pool fails to connect', () => {
    let caughtError: unknown
    let connectionError: Error

    beforeEach(async () => {
      connectionError = new Error('timeout exceeded when trying to connect')
      connect = jest.fn().mockRejectedValue(connectionError)
      caughtError = await connectWithSignal({ connect }, controller.signal).catch((error: unknown) => error)
    })

    it('should reject with the connection error', () => {
      expect(caughtError).toBe(connectionError)
    })
  })
})
