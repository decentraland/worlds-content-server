import { createUpdateOwnerJob } from '../../src/adapters/update-owner-job'
import { createDatabaseMock } from '../mocks/database-mock'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockBlockingComponent } from '../mocks/blocking-mock'
import { IPgComponent } from '@dcl/pg-component'
import { IBlockingComponent } from '../../src/adapters/blocking'

describe('UpdateOwnerJob', () => {
  const badOwner = '0xbad0000000000000000000000000000000000001'
  const goodOwner = '0x9000000000000000000000000000000000000002'

  let database: IPgComponent
  let blocking: jest.Mocked<IBlockingComponent>
  let logs: ReturnType<typeof createMockLogs>

  beforeEach(() => {
    logs = createMockLogs()
    // Owners already match name ownership, so Step 1 performs no UPDATE and the only DB query
    // is the initial enumeration of worlds with deployed scenes.
    database = createDatabaseMock([
      {
        rows: [
          { name: 'bad-world.dcl.eth', owner: badOwner, size: '100' },
          { name: 'good-world.dcl.eth', owner: goodOwner, size: '100' }
        ],
        rowCount: 2
      }
    ])
  })

  describe('when one wallet fails while its blocking status is evaluated', () => {
    beforeEach(async () => {
      blocking = createMockBlockingComponent({
        blockIfOverQuota: jest.fn().mockImplementation((wallet: string) =>
          wallet === badOwner ? Promise.reject(new Error('boom: wallet stats service unavailable')) : Promise.resolve(true)
        )
      })

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(
          new Map([
            ['bad-world.dcl.eth', badOwner],
            ['good-world.dcl.eth', goodOwner]
          ])
        )
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership })
      await job.run()
    })

    it('should still evaluate the wallets after the failing one', () => {
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(badOwner)
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(goodOwner)
    })

    it('should log the error for the failing wallet', () => {
      const logger = logs.getLogger('update-owner-job')
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(badOwner),
        expect.objectContaining({ error: expect.any(String) })
      )
    })

    it('should still collect stale blocking records at the end of the run', () => {
      expect(blocking.collectStaleBlockingRecords).toHaveBeenCalledTimes(1)
    })

    it('should exclude the failed wallet, but not the processed one, from the cleanup', () => {
      const [, keepWallets] = blocking.collectStaleBlockingRecords.mock.calls[0]
      expect(keepWallets.has(badOwner)).toBe(true)
      expect(keepWallets.has(goodOwner)).toBe(false)
    })
  })

  describe('when every wallet is evaluated successfully', () => {
    beforeEach(async () => {
      blocking = createMockBlockingComponent()

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(
          new Map([
            ['bad-world.dcl.eth', badOwner],
            ['good-world.dcl.eth', goodOwner]
          ])
        )
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership })
      await job.run()
    })

    it('should evaluate the blocking status of every distinct owner', () => {
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(badOwner)
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(goodOwner)
    })

    it('should collect stale blocking records excluding no wallet', () => {
      const [, keepWallets] = blocking.collectStaleBlockingRecords.mock.calls[0]
      expect(keepWallets.size).toBe(0)
    })
  })
})
