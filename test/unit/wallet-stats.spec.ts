import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IFetchComponent } from '@dcl/core-commons'
import { IPgComponent } from '@dcl/pg-component'
import { createWalletStatsComponent } from '../../src/adapters/wallet-stats'
import { createDatabaseMock } from '../mocks/database-mock'
import { getIdentity, Identity } from '../utils'
import { MB_BigInt, WalletStats } from '../../src/types'

type FetchInit = { abortController: AbortController }

/** Rejects once the request's controller aborts, like a request to a stalled server. */
function untilAborted(init: FetchInit) {
  return new Promise<never>((_, reject) => {
    init.abortController.signal.addEventListener('abort', () => reject(new Error('Request aborted (timed out)')))
  })
}

function holdingsResponse(spaceAllowance: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        data: { owner: '0x0', ownedLands: 1, ownedNames: 1, ownedMana: 0, spaceAllowance }
      })
  }
}

describe('wallet stats', function () {
  let identity: Identity
  let logs: ILoggerComponent
  let config: IConfigComponent
  let database: IPgComponent
  let fetchMock: jest.Mock
  let fetch: IFetchComponent
  let stats: WalletStats | undefined
  let error: Error | undefined

  beforeEach(async () => {
    identity = await getIdentity()
    config = createConfigComponent({ DCL_NAME_STATS_URL: 'https://some-api.dcl.net', LOG_LEVEL: 'ERROR' })
    database = createDatabaseMock([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] }
    ])
    fetchMock = jest.fn()
    fetch = { fetch: fetchMock }
    stats = undefined
    error = undefined
  })

  const getStats = async () => {
    logs = await createLogComponent({ config })
    const walletStats = await createWalletStatsComponent({ config, database, fetch, logs })
    try {
      stats = await walletStats.get(identity.realAccount.address)
    } catch (e) {
      error = e as Error
    }
  }

  describe('when no stats url is configured', () => {
    beforeEach(async () => {
      config = createConfigComponent({ LOG_LEVEL: 'ERROR' })
      await getStats()
    })

    it('should not ask the stats service', () => {
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('should give the wallet an unlimited allowance', () => {
      expect(stats).toEqual({
        wallet: identity.realAccount.address,
        dclNames: [],
        ensNames: [],
        maxAllowedSpace: BigInt(Number.MAX_SAFE_INTEGER) * MB_BigInt,
        usedSpace: 0n
      })
    })
  })

  describe('when the wallet owns no worlds', () => {
    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce(holdingsResponse(0))
      await getStats()
    })

    it('should report no names, no used space and the allowance', () => {
      expect(stats).toEqual({
        wallet: identity.realAccount.address,
        dclNames: [],
        ensNames: [],
        maxAllowedSpace: 0n,
        usedSpace: 0n
      })
    })
  })

  describe('when the wallet owns worlds and is blocked', () => {
    let blockedAt: Date

    beforeEach(async () => {
      blockedAt = new Date()
      database = createDatabaseMock([
        {
          rowCount: 2,
          rows: [
            { name: 'name.dcl.eth', size: (100n * MB_BigInt).toString() },
            { name: 'name.eth', size: (15n * MB_BigInt).toString() }
          ]
        },
        { rowCount: 1, rows: [{ created_at: blockedAt }] }
      ])
      fetchMock.mockResolvedValueOnce(holdingsResponse(200))
      await getStats()
    })

    it('should split the sizes by name kind, count only DCL names as used and report the block', () => {
      expect(stats).toEqual({
        wallet: identity.realAccount.address,
        dclNames: [{ name: 'name.dcl.eth', size: 100n * MB_BigInt }],
        ensNames: [{ name: 'name.eth', size: 15n * MB_BigInt }],
        maxAllowedSpace: 200n * MB_BigInt,
        usedSpace: 100n * MB_BigInt,
        blockedSince: blockedAt
      })
    })
  })

  describe('when the stats service never answers', () => {
    beforeEach(async () => {
      config = createConfigComponent({
        DCL_NAME_STATS_URL: 'https://some-api.dcl.net',
        DCL_NAME_STATS_TIMEOUT_MS: '10',
        LOG_LEVEL: 'ERROR'
      })
      fetchMock.mockImplementation((_url: string, init: FetchInit) => untilAborted(init))
      await getStats()
    })

    it('should give up after timing out each of its 3 attempts', () => {
      expect({ attempts: fetchMock.mock.calls.length, message: error?.message }).toEqual({
        attempts: 3,
        message: 'Request aborted (timed out)'
      })
    })
  })

  describe('when the stats service stalls while sending the body', () => {
    beforeEach(async () => {
      config = createConfigComponent({
        DCL_NAME_STATS_URL: 'https://some-api.dcl.net',
        DCL_NAME_STATS_TIMEOUT_MS: '10',
        LOG_LEVEL: 'ERROR'
      })
      fetchMock.mockImplementation((_url: string, init: FetchInit) =>
        Promise.resolve({ ok: true, json: () => untilAborted(init) })
      )
      await getStats()
    })

    it('should give up after timing out each of its 3 attempts', () => {
      expect({ attempts: fetchMock.mock.calls.length, message: error?.message }).toEqual({
        attempts: 3,
        message: 'Request aborted (timed out)'
      })
    })
  })

  describe('when a slow attempt is followed by a timely one', () => {
    beforeEach(async () => {
      config = createConfigComponent({
        DCL_NAME_STATS_URL: 'https://some-api.dcl.net',
        DCL_NAME_STATS_TIMEOUT_MS: '10',
        LOG_LEVEL: 'ERROR'
      })
      fetchMock
        .mockImplementationOnce((_url: string, init: FetchInit) => untilAborted(init))
        .mockResolvedValueOnce(holdingsResponse(50))
      await getStats()
    })

    it('should use the answer of the retry', () => {
      expect(stats?.maxAllowedSpace).toBe(50n * MB_BigInt)
    })
  })
})
