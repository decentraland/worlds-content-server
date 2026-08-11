import { createUpdateOwnerJob } from '../../src/adapters/update-owner-job'
import { createDatabaseMock } from '../mocks/database-mock'
import { createMockedNameOwnership } from '../mocks/name-ownership-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { createMockBlockingComponent } from '../mocks/blocking-mock'
import { createMockedPermissionsManager } from '../mocks/permissions-manager-mock'
import { IPgComponent } from '@dcl/pg-component'
import { IBlockingComponent } from '../../src/adapters/blocking'
import { IPermissionsManager } from '../../src/types'
import { SQLStatement } from 'sql-template-strings'

describe('UpdateOwnerJob', () => {
  const badOwner = '0xbad0000000000000000000000000000000000001'
  const goodOwner = '0x9000000000000000000000000000000000000002'

  let database: IPgComponent
  let blocking: jest.Mocked<IBlockingComponent>
  let permissionsManager: jest.Mocked<IPermissionsManager>
  let logs: ReturnType<typeof createMockLogs>

  beforeEach(() => {
    logs = createMockLogs()
    permissionsManager = createMockedPermissionsManager()
    // Owners already match name ownership, so Step 1 performs no UPDATE and the only DB query
    // is the initial enumeration of worlds with deployed scenes.
    database = createDatabaseMock([
      {
        rows: [
          { name: 'bad-world.dcl.eth', owner: badOwner, size: '100', has_deployed_scenes: true },
          { name: 'good-world.dcl.eth', owner: goodOwner, size: '100', has_deployed_scenes: true }
        ],
        rowCount: 2
      }
    ])
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('when one wallet fails while its blocking status is evaluated', () => {
    beforeEach(async () => {
      blocking = createMockBlockingComponent({
        blockIfOverQuota: jest
          .fn()
          .mockImplementation((wallet: string) =>
            wallet === badOwner
              ? Promise.reject(new Error('boom: wallet stats service unavailable'))
              : Promise.resolve(true)
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

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
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

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
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

  describe('when the owner of every world still matches the one on chain', () => {
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

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
      await job.run()
    })

    it('should not revoke any permission', () => {
      expect(permissionsManager.deletePermissionsNotGrantedUnderOwner).not.toHaveBeenCalled()
    })
  })

  describe('when a world that changed owners holds permissions but no deployed scene', () => {
    const newOwner = '0xnew0000000000000000000000000000000000003'.toLowerCase()

    beforeEach(async () => {
      blocking = createMockBlockingComponent()

      database = createDatabaseMock([
        {
          rows: [{ name: 'empty-world.dcl.eth', owner: badOwner, size: '0', has_deployed_scenes: false }],
          rowCount: 1
        },
        // The UPDATE of the owner column
        { rows: [], rowCount: 1 }
      ])

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(new Map([['empty-world.dcl.eth', newOwner]]))
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
      await job.run()
    })

    it('should still revoke the permissions that predate the ownership change', () => {
      expect(permissionsManager.deletePermissionsNotGrantedUnderOwner).toHaveBeenCalledWith(
        'empty-world.dcl.eth',
        newOwner
      )
    })

    it('should not evaluate the blocking status of its owner, since it uses no quota', () => {
      expect(blocking.blockIfOverQuota).not.toHaveBeenCalled()
    })
  })

  describe('when the current owner of a world cannot be resolved', () => {
    let querySpy: jest.SpyInstance

    beforeEach(async () => {
      blocking = createMockBlockingComponent()

      database = createDatabaseMock([
        {
          rows: [{ name: 'unresolved-world.dcl.eth', owner: badOwner, size: '100', has_deployed_scenes: true }],
          rowCount: 1
        }
      ])
      querySpy = jest.spyOn(database, 'query')

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(new Map())
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
      await job.run()
    })

    it('should not overwrite the stored owner of the world', () => {
      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('should not revoke any permission over an unresolved owner', () => {
      expect(permissionsManager.deletePermissionsNotGrantedUnderOwner).not.toHaveBeenCalled()
    })

    it('should log a warning naming the skipped world', () => {
      const logger = logs.getLogger('update-owner-job')
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unresolved-world.dcl.eth'))
    })

    it('should keep the blocking record of the owner the world is still attributed to', () => {
      const [, keepWallets] = blocking.collectStaleBlockingRecords.mock.calls[0]
      expect(keepWallets.has(badOwner)).toBe(true)
    })
  })

  describe('when a world changed owners', () => {
    const newOwner = '0xnew0000000000000000000000000000000000003'.toLowerCase()

    let querySpy: jest.SpyInstance
    let transactionDepth: number
    let revocationRanInsideTransaction: boolean

    beforeEach(async () => {
      blocking = createMockBlockingComponent()
      transactionDepth = 0
      revocationRanInsideTransaction = false

      database = createDatabaseMock([
        {
          rows: [{ name: 'sold-world.dcl.eth', owner: badOwner, size: '100', has_deployed_scenes: true }],
          rowCount: 1
        },
        // The UPDATE of the owner column
        { rows: [], rowCount: 1 }
      ])

      querySpy = jest.spyOn(database, 'query')
      jest.spyOn(database, 'withAsyncContextTransaction').mockImplementation(async (callback) => {
        transactionDepth++
        try {
          return await callback()
        } finally {
          transactionDepth--
        }
      })

      permissionsManager = createMockedPermissionsManager({
        deletePermissionsNotGrantedUnderOwner: jest.fn().mockImplementation(async () => {
          revocationRanInsideTransaction = transactionDepth > 0
          return [{ address: '0xabc0000000000000000000000000000000000004', permissionType: 'deployment' }]
        })
      })

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(new Map([['sold-world.dcl.eth', newOwner]]))
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
      await job.run()
    })

    it('should persist the new owner of the world', () => {
      const updateStatement = querySpy.mock.calls[1][0] as SQLStatement
      expect(updateStatement.values).toEqual([newOwner, 'sold-world.dcl.eth'])
    })

    it('should revoke the permissions that were not granted under the new owner', () => {
      expect(permissionsManager.deletePermissionsNotGrantedUnderOwner).toHaveBeenCalledWith(
        'sold-world.dcl.eth',
        newOwner
      )
    })

    it('should revoke the permissions in the same transaction that persists the new owner', () => {
      expect(revocationRanInsideTransaction).toBe(true)
    })

    it('should evaluate the blocking status of the new owner', () => {
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(newOwner)
    })
  })

  describe('and applying the ownership change of a world fails', () => {
    const newOwner = '0xnew0000000000000000000000000000000000003'.toLowerCase()

    beforeEach(async () => {
      blocking = createMockBlockingComponent()

      database = createDatabaseMock([
        {
          rows: [
            { name: 'sold-world.dcl.eth', owner: badOwner, size: '100', has_deployed_scenes: true },
            { name: 'good-world.dcl.eth', owner: goodOwner, size: '100', has_deployed_scenes: true }
          ],
          rowCount: 2
        }
      ])

      jest
        .spyOn(database, 'withAsyncContextTransaction')
        .mockRejectedValue(new Error('boom: could not commit the ownership change'))

      const nameOwnership = createMockedNameOwnership({
        findOwners: jest.fn().mockResolvedValue(
          new Map([
            ['sold-world.dcl.eth', newOwner],
            ['good-world.dcl.eth', goodOwner]
          ])
        )
      })

      const job = await createUpdateOwnerJob({ blocking, database, logs, nameOwnership, permissionsManager })
      await job.run()
    })

    it('should log the error naming the world that could not be updated', () => {
      const logger = logs.getLogger('update-owner-job')
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('sold-world.dcl.eth'),
        expect.objectContaining({ error: expect.any(String) })
      )
    })

    it('should still evaluate the blocking status of the remaining owners', () => {
      expect(blocking.blockIfOverQuota).toHaveBeenCalledWith(goodOwner)
    })

    it('should still collect stale blocking records at the end of the run', () => {
      expect(blocking.collectStaleBlockingRecords).toHaveBeenCalledTimes(1)
    })

    it('should keep the blocking record of the owner the world is still attributed to', () => {
      const [, keepWallets] = blocking.collectStaleBlockingRecords.mock.calls[0]
      expect(keepWallets.has(badOwner)).toBe(true)
    })
  })
})
