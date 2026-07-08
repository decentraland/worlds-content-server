import { Events } from '@dcl/schemas'
import { IPgComponent } from '@dcl/pg-component'
import { createBlockingComponent, IBlockingComponent } from '../../src/adapters/blocking'
import { IWalletStats, WalletStats, Whitelist } from '../../src/types'
import { createDatabaseMock } from '../mocks/database-mock'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockedSnsClient } from '../mocks/sns-client-mock'
import { createMockWhitelistComponent } from '../mocks/whitelist-mock'

describe('blocking', () => {
  const wallet = '0xabc0000000000000000000000000000000000001'

  let logs: ReturnType<typeof createMockLogs>
  let snsClient: ReturnType<typeof createMockedSnsClient>
  let config: ReturnType<typeof createMockedConfig>

  beforeEach(() => {
    logs = createMockLogs()
    snsClient = createMockedSnsClient({ publishMessages: jest.fn().mockResolvedValue(undefined) })
    config = createMockedConfig({
      requireString: jest
        .fn()
        .mockImplementation((key: string) => Promise.resolve(key === 'WHITELIST_URL' ? 'http://whitelist' : 'http://builder'))
    })
  })

  function statsWith(overrides: Partial<WalletStats>): WalletStats {
    return {
      wallet,
      dclNames: [],
      ensNames: [],
      usedSpace: 0n,
      maxAllowedSpace: 0n,
      blockedSince: undefined,
      ...overrides
    }
  }

  async function createComponent(
    dbResults: any[],
    stats: WalletStats | Error,
    whitelist: Whitelist = {}
  ): Promise<{
    component: IBlockingComponent
    query: jest.Mock
    walletStats: jest.Mocked<IWalletStats>
  }> {
    const databaseMock = createDatabaseMock(dbResults)
    const query = jest.fn(databaseMock.query)
    const database = { ...databaseMock, query } as unknown as IPgComponent
    const walletStats = {
      get: jest.fn(stats instanceof Error ? () => Promise.reject(stats) : () => Promise.resolve(stats))
    } as unknown as jest.Mocked<IWalletStats>
    const whitelistComponent = createMockWhitelistComponent(whitelist)

    const component = await createBlockingComponent({
      config,
      database,
      logs,
      snsClient,
      walletStats,
      whitelist: whitelistComponent
    })
    return { component, query, walletStats }
  }

  describe('blockIfOverQuota', () => {
    describe('when the wallet is over its allowed quota', () => {
      let result: boolean

      beforeEach(async () => {
        const now = new Date()
        const { component } = await createComponent(
          [{ rowCount: 1, rows: [{ wallet, created_at: now, updated_at: now }] }],
          statsWith({ usedSpace: 200n, maxAllowedSpace: 100n })
        )
        result = await component.blockIfOverQuota(wallet)
      })

      it('should report that a blocking record was created', () => {
        expect(result).toBe(true)
      })

      it('should publish a missing-resources warning for the freshly blocked wallet', () => {
        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({ subType: Events.SubType.Worlds.WORLDS_MISSING_RESOURCES })
        ])
      })
    })

    describe('when the wallet is under its allowed quota', () => {
      let result: boolean
      let query: jest.Mock

      beforeEach(async () => {
        const created = await createComponent([], statsWith({ usedSpace: 50n, maxAllowedSpace: 100n }))
        query = created.query
        result = await created.component.blockIfOverQuota(wallet)
      })

      it('should not create a blocking record', () => {
        expect(result).toBe(false)
        expect(query).not.toHaveBeenCalled()
      })

      it('should not publish any notification', () => {
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })

    describe('and the wallet is only over quota before discounting its whitelisted worlds', () => {
      let result: boolean
      let query: jest.Mock

      beforeEach(async () => {
        const created = await createComponent(
          [],
          statsWith({
            usedSpace: 200n,
            maxAllowedSpace: 100n,
            dclNames: [{ name: 'whitelisted.dcl.eth', size: 150n }]
          }),
          { 'whitelisted.dcl.eth': {} }
        )
        query = created.query
        result = await created.component.blockIfOverQuota(wallet)
      })

      it('should treat the wallet as under quota and not block it', () => {
        expect(result).toBe(false)
        expect(query).not.toHaveBeenCalled()
      })
    })
  })

  describe('unblockIfUnderQuota', () => {
    describe('when the wallet is not blocked', () => {
      let result: boolean
      let query: jest.Mock
      let walletStats: jest.Mocked<IWalletStats>

      beforeEach(async () => {
        const created = await createComponent([{ rowCount: 0, rows: [] }], statsWith({}))
        query = created.query
        walletStats = created.walletStats
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should report the wallet was not unblocked', () => {
        expect(result).toBe(false)
      })

      it('should not fetch the (expensive) wallet stats', () => {
        expect(walletStats.get).not.toHaveBeenCalled()
      })

      it('should only run the cheap blocked-status lookup', () => {
        expect(query).toHaveBeenCalledTimes(1)
      })
    })

    describe('when the wallet is blocked and back under quota', () => {
      let result: boolean
      let query: jest.Mock
      const blockedAt = new Date('2026-06-29T00:00:07Z')

      beforeEach(async () => {
        const created = await createComponent(
          [
            { rowCount: 1, rows: [{ created_at: blockedAt }] },
            { rowCount: 1, rows: [] }
          ],
          statsWith({ usedSpace: 50n, maxAllowedSpace: 100n })
        )
        query = created.query
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should report the wallet was unblocked', () => {
        expect(result).toBe(true)
      })

      it('should delete the blocking record', () => {
        expect(query).toHaveBeenCalledTimes(2)
      })

      it('should publish an access-restored notification', () => {
        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({
            subType: Events.SubType.Worlds.WORLDS_ACCESS_RESTORED,
            metadata: expect.objectContaining({ attendee: wallet })
          })
        ])
      })
    })

    describe('when the wallet is unblocked but publishing the restored event fails', () => {
      let result: boolean
      const blockedAt = new Date('2026-06-29T00:00:07Z')

      beforeEach(async () => {
        snsClient.publishMessages.mockRejectedValueOnce(new Error('sns down'))
        const created = await createComponent(
          [
            { rowCount: 1, rows: [{ created_at: blockedAt }] },
            { rowCount: 1, rows: [] }
          ],
          statsWith({ usedSpace: 50n, maxAllowedSpace: 100n })
        )
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should still report the wallet as unblocked (the delete is authoritative)', () => {
        expect(result).toBe(true)
      })
    })

    describe('when the wallet is blocked but only under quota after discounting its whitelisted worlds', () => {
      let result: boolean
      const blockedAt = new Date('2026-06-29T00:00:07Z')

      beforeEach(async () => {
        const created = await createComponent(
          [
            { rowCount: 1, rows: [{ created_at: blockedAt }] },
            { rowCount: 1, rows: [] }
          ],
          statsWith({
            usedSpace: 200n,
            maxAllowedSpace: 100n,
            dclNames: [{ name: 'whitelisted.dcl.eth', size: 150n }]
          }),
          { 'whitelisted.dcl.eth': {} }
        )
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should unblock the wallet using the whitelist-discounted quota', () => {
        expect(result).toBe(true)
        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({ subType: Events.SubType.Worlds.WORLDS_ACCESS_RESTORED })
        ])
      })
    })

    describe('when the wallet is blocked and still over quota', () => {
      let result: boolean
      let query: jest.Mock
      const blockedAt = new Date('2026-06-29T00:00:07Z')

      beforeEach(async () => {
        const created = await createComponent(
          [{ rowCount: 1, rows: [{ created_at: blockedAt }] }],
          statsWith({ usedSpace: 300n, maxAllowedSpace: 100n })
        )
        query = created.query
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should not unblock the wallet', () => {
        expect(result).toBe(false)
      })

      it('should not delete the blocking record', () => {
        expect(query).toHaveBeenCalledTimes(1)
      })

      it('should not publish any notification', () => {
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })

    describe('when evaluating the wallet stats fails', () => {
      let result: boolean

      beforeEach(async () => {
        const blockedAt = new Date('2026-06-29T00:00:07Z')
        const created = await createComponent(
          [{ rowCount: 1, rows: [{ created_at: blockedAt }] }],
          new Error('wallet stats service unavailable')
        )
        result = await created.component.unblockIfUnderQuota(wallet)
      })

      it('should swallow the error and report the wallet was not unblocked', () => {
        expect(result).toBe(false)
      })

      it('should log the failure', () => {
        expect(logs.getLogger('blocking').error).toHaveBeenCalledWith(
          expect.stringContaining(wallet),
          expect.objectContaining({ error: expect.any(String) })
        )
      })
    })
  })

  describe('collectStaleBlockingRecords', () => {
    describe('when there are wallets to keep', () => {
      let query: jest.Mock
      const keptWallet = '0xKEEP000000000000000000000000000000000001'

      beforeEach(async () => {
        const created = await createComponent(
          [{ rowCount: 1, rows: [{ wallet, created_at: new Date('2026-06-29T00:00:07Z') }] }],
          statsWith({})
        )
        query = created.query
        await created.component.collectStaleBlockingRecords(new Date(), new Set([keptWallet]))
      })

      it('should exclude the kept wallets from the deletion, lowercased to match the stored rows', () => {
        const sql = query.mock.calls[0][0]
        expect(sql.text).toContain('!= ALL')
        expect(sql.values).toEqual(expect.arrayContaining([expect.arrayContaining([keptWallet.toLowerCase()])]))
      })

      it('should publish an access-restored notification for each removed record', () => {
        expect(snsClient.publishMessages).toHaveBeenCalledWith([
          expect.objectContaining({ subType: Events.SubType.Worlds.WORLDS_ACCESS_RESTORED })
        ])
      })
    })

    describe('when there are no wallets to keep', () => {
      let query: jest.Mock

      beforeEach(async () => {
        const created = await createComponent([{ rowCount: 0, rows: [] }], statsWith({}))
        query = created.query
        await created.component.collectStaleBlockingRecords(new Date(), new Set())
      })

      it('should delete without an exclusion clause', () => {
        const sql = query.mock.calls[0][0]
        expect(sql.text).not.toContain('ALL')
      })

      it('should not publish notifications when nothing was removed', () => {
        expect(snsClient.publishMessages).not.toHaveBeenCalled()
      })
    })
  })
})
