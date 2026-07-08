import { createUpdateOwnerJob } from '../../src/adapters/update-owner-job'
import { createDatabaseMock } from '../mocks/database-mock'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockedSnsClient } from '../mocks/sns-client-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { IPgComponent } from '@dcl/pg-component'
import { IWalletStats } from '../../src/types'

describe('UpdateOwnerJob', () => {
  const badOwner = '0xbad0000000000000000000000000000000bad0'
  const goodOwner = '0xgood000000000000000000000000000000d000'

  describe('when one wallet fails while calculating its blocking status', () => {
    let database: jest.Mocked<IPgComponent>
    let walletStats: jest.Mocked<IWalletStats>
    let logs: ReturnType<typeof createMockLogs>

    beforeEach(async () => {
      const databaseMock = createDatabaseMock([
        // Step 1: worlds with deployed scenes, one per owner
        {
          rows: [
            { name: 'bad-world.dcl.eth', owner: badOwner, size: '100' },
            { name: 'good-world.dcl.eth', owner: goodOwner, size: '100' }
          ],
          rowCount: 2
        },
        // upsertBlockingRecord for goodOwner (only one reached, since badOwner throws)
        { rows: [], rowCount: 0 },
        // clearOldBlockingRecords
        { rows: [], rowCount: 0 }
      ])
      database = {
        ...databaseMock,
        query: jest.fn(databaseMock.query)
      } as any

      walletStats = {
        get: jest.fn().mockImplementation((wallet: string) => {
          if (wallet === badOwner) {
            return Promise.reject(new Error('boom: wallet stats service unavailable'))
          }
          return Promise.resolve({
            wallet: goodOwner,
            dclNames: [{ name: 'good-world.dcl.eth', size: 1000n }],
            ensNames: [],
            usedSpace: 1000n,
            maxAllowedSpace: 100n,
            blockedSince: undefined
          })
        }),
        clearBlockedIfUnderQuota: jest.fn().mockResolvedValue({ unblocked: false, stats: {} })
      }

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(
          new Map([
            ['bad-world.dcl.eth', badOwner],
            ['good-world.dcl.eth', goodOwner]
          ])
        )
      })
      const snsClient = createMockedSnsClient()
      const fetch = createMockFetch({
        fetch: jest.fn().mockResolvedValue({ json: () => Promise.resolve({}) })
      })
      const config = createMockedConfig({
        requireString: jest.fn().mockResolvedValue('http://example.com/whatever')
      })
      logs = createMockLogs()

      const job = await createUpdateOwnerJob({
        config,
        database,
        fetch,
        logs,
        nameOwnership,
        snsClient,
        walletStats
      })

      await job.run()
    })

    it('does not throw and still processes the wallet after the failing one', () => {
      expect(walletStats.get).toHaveBeenCalledWith(badOwner)
      expect(walletStats.get).toHaveBeenCalledWith(goodOwner)
    })

    it('logs the error for the failing wallet', () => {
      const errorLogger = logs.getLogger('update-owner-job')
      expect(errorLogger.error).toHaveBeenCalledWith(expect.stringContaining(badOwner))
    })

    it('still reaches clearOldBlockingRecords at the end of the run', () => {
      // 1 select + 1 upsertBlockingRecord (goodOwner only) + 1 clearOldBlockingRecords = 3 queries
      expect(database.query).toHaveBeenCalledTimes(3)
    })
  })
})
