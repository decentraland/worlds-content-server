import { createConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createFetchComponent } from '../../src/adapters/fetch'
import { IPgComponent } from '@dcl/pg-component'
import { createWalletStatsComponent } from '../../src/adapters/wallet-stats'
import { createDatabaseMock } from '../mocks/database-mock'
import { getIdentity, Identity } from '../utils'
import { IWorldsManager, MB_BigInt } from '../../src/types'
import { createMockedWorldsManager } from '../mocks/worlds-manager-mock'

describe('wallet stats', function () {
  let identity: Identity

  let logs: ILoggerComponent
  let config: IConfigComponent
  let database: IPgComponent
  let worldsManager: jest.Mocked<IWorldsManager>

  beforeEach(async () => {
    identity = await getIdentity()
    config = createConfigComponent({
      DCL_NAME_STATS_URL: 'https://some-api.dcl.net',
      LOG_LEVEL: 'DEBUG'
    })
    logs = await createLogComponent({ config })
    database = createDatabaseMock([
      {
        rowCount: 0,
        rows: []
      },
      {
        rowCount: 0,
        rows: []
      }
    ])
    worldsManager = createMockedWorldsManager()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('when no url provided, it creates a component that does not validate anything, always max integer as allowance', async () => {
    config = createConfigComponent({
      LOG_LEVEL: 'DEBUG'
    })
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockRejectedValue('should never be called')

    const walletStatsComponent = await createWalletStatsComponent({
      config,
      database,
      fetch,
      logs,
      worldsManager
    })
    await expect(walletStatsComponent.get(identity.realAccount.address)).resolves.toEqual({
      wallet: identity.realAccount.address,
      dclNames: [],
      ensNames: [],
      maxAllowedSpace: BigInt(Number.MAX_SAFE_INTEGER) * MB_BigInt,
      usedSpace: 0n
    })
  })

  it('gather the data and produces a valid result object when wallet does not exist', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            owner: identity.realAccount.address,
            ownedLands: 0,
            ownedNames: 0,
            ownedMana: 0,
            spaceAllowance: 0
          }
        })
    })

    const walletStatsComponent = await createWalletStatsComponent({
      config,
      database,
      fetch,
      logs,
      worldsManager
    })

    await expect(walletStatsComponent.get(identity.realAccount.address)).resolves.toEqual({
      dclNames: [],
      ensNames: [],
      maxAllowedSpace: 0n,
      usedSpace: 0n,
      wallet: identity.realAccount.address
    })
  })

  it('gather the data and produces a valid result object when wallet is active', async () => {
    const fetch = await createFetchComponent()
    fetch.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            owner: identity.realAccount.address,
            ownedLands: 1,
            ownedNames: 1,
            ownedMana: 0,
            spaceAllowance: 200
          }
        })
    })

    const blockedAt = new Date()
    const localDatabase = createDatabaseMock([
      {
        rowCount: 2,
        rows: [{ name: 'name.dcl.eth' }, { name: 'name.eth' }]
      },
      {
        rowCount: 1,
        rows: [{ created_at: blockedAt }]
      }
    ])

    worldsManager.getTotalWorldSize.mockImplementation((worldName: string) => {
      if (worldName === 'name.dcl.eth') {
        return Promise.resolve(BigInt(100 * 1024 * 1024))
      }
      if (worldName === 'name.eth') {
        return Promise.resolve(BigInt(15 * 1024 * 1024))
      }
      return Promise.resolve(0n)
    })

    const walletStatsComponent = await createWalletStatsComponent({
      config,
      database: localDatabase,
      fetch,
      logs,
      worldsManager
    })

    await expect(walletStatsComponent.get(identity.realAccount.address)).resolves.toEqual({
      dclNames: [
        {
          name: 'name.dcl.eth',
          size: 104857600n
        }
      ],
      ensNames: [
        {
          name: 'name.eth',
          size: 15728640n
        }
      ],
      maxAllowedSpace: 209715200n,
      usedSpace: 104857600n,
      wallet: identity.realAccount.address,
      blockedSince: blockedAt
    })
  })

  describe('clearBlockedIfUnderQuota', () => {
    it('deletes the blocked row and returns unblocked=true when wallet is blocked but under quota', async () => {
      const fetch = await createFetchComponent()
      fetch.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              owner: identity.realAccount.address,
              ownedLands: 1,
              ownedNames: 1,
              ownedMana: 0,
              spaceAllowance: 400
            }
          })
      })

      const blockedAt = new Date('2026-06-29T00:00:07Z')
      const localDatabase = createDatabaseMock([
        // get() -> fetchStoredData query
        { rowCount: 1, rows: [{ name: 'world.dcl.eth' }] },
        // get() -> fetchBlockedStatus query
        { rowCount: 1, rows: [{ created_at: blockedAt }] },
        // clearBlockedIfUnderQuota -> DELETE FROM blocked
        { rowCount: 1, rows: [] }
      ])

      worldsManager.getTotalWorldSize.mockResolvedValue(BigInt(100 * 1024 * 1024))

      const walletStatsComponent = await createWalletStatsComponent({
        config,
        database: localDatabase,
        fetch,
        logs,
        worldsManager
      })

      const result = await walletStatsComponent.clearBlockedIfUnderQuota(identity.realAccount.address)

      expect(result.unblocked).toBe(true)
      expect(result.stats.blockedSince).toBeUndefined()
      expect(result.stats.usedSpace).toBe(BigInt(100 * 1024 * 1024))
      expect(result.stats.maxAllowedSpace).toBe(BigInt(400) * MB_BigInt)
    })

    it('returns unblocked=false and does not delete when wallet is still over quota', async () => {
      const fetch = await createFetchComponent()
      fetch.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              owner: identity.realAccount.address,
              ownedLands: 1,
              ownedNames: 1,
              ownedMana: 0,
              spaceAllowance: 50
            }
          })
      })

      const blockedAt = new Date('2026-06-29T00:00:07Z')
      const localDatabase = createDatabaseMock([
        // get() -> fetchStoredData query
        { rowCount: 1, rows: [{ name: 'world.dcl.eth' }] },
        // get() -> fetchBlockedStatus query
        { rowCount: 1, rows: [{ created_at: blockedAt }] }
      ])

      worldsManager.getTotalWorldSize.mockResolvedValue(BigInt(100 * 1024 * 1024))

      const walletStatsComponent = await createWalletStatsComponent({
        config,
        database: localDatabase,
        fetch,
        logs,
        worldsManager
      })

      const result = await walletStatsComponent.clearBlockedIfUnderQuota(identity.realAccount.address)

      expect(result.unblocked).toBe(false)
      expect(result.stats.blockedSince).toEqual(blockedAt)
    })

    it('returns unblocked=false when wallet is not blocked at all', async () => {
      const fetch = await createFetchComponent()
      fetch.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              owner: identity.realAccount.address,
              ownedLands: 1,
              ownedNames: 1,
              ownedMana: 0,
              spaceAllowance: 400
            }
          })
      })

      const localDatabase = createDatabaseMock([
        // get() -> fetchStoredData query
        { rowCount: 0, rows: [] },
        // get() -> fetchBlockedStatus query
        { rowCount: 0, rows: [] }
      ])

      const walletStatsComponent = await createWalletStatsComponent({
        config,
        database: localDatabase,
        fetch,
        logs,
        worldsManager
      })

      const result = await walletStatsComponent.clearBlockedIfUnderQuota(identity.realAccount.address)

      expect(result.unblocked).toBe(false)
      expect(result.stats.blockedSince).toBeUndefined()
    })
  })
})
