import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { createContentGcComponent, GarbageCollection, IContentGcComponent } from '../../src/logic/content-gc'

type Components = Parameters<typeof createContentGcComponent>[0]

const NOW = 1_800_000_000_000
const TTL_MS = 60_000

describe('when collecting unreferenced content', () => {
  let withWrite: jest.Mock
  let storageDelete: jest.Mock
  let increment: jest.Mock
  let info: jest.Mock
  let pendingScenesRepository: {
    getReferencedContentKeys: jest.Mock
    listExpired: jest.Mock
    getUploadKeys: jest.Mock
    releaseExpired: jest.Mock
  }
  let partialUploadAdmission: {
    pruneAndReport: jest.Mock
    recordCleanupFinished: jest.Mock
  }
  let storedKeys: string[]
  let referencedKeys: string[]
  let calls: string[]
  let contentGc: IContentGcComponent

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    storedKeys = []
    referencedKeys = []
    calls = []
    withWrite = jest.fn((operation: () => Promise<unknown>) => operation())
    storageDelete = jest.fn(async (keys: string[]) => {
      calls.push(`delete:${keys.join(',')}`)
    })
    increment = jest.fn()
    info = jest.fn()
    pendingScenesRepository = {
      getReferencedContentKeys: jest.fn(
        async (_cutoff: Date, candidates: string[]) => new Set(candidates.filter((key) => referencedKeys.includes(key)))
      ),
      listExpired: jest.fn().mockResolvedValue([]),
      getUploadKeys: jest.fn(),
      releaseExpired: jest.fn(async (entityId: string) => {
        calls.push(`release:${entityId}`)
      })
    }
    partialUploadAdmission = {
      pruneAndReport: jest.fn().mockResolvedValue(undefined),
      recordCleanupFinished: jest.fn()
    }
    contentGc = await createContentGcComponent({
      logs: { getLogger: () => ({ info, warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }) },
      metrics: { increment, observe: jest.fn(), startTimer: jest.fn().mockReturnValue({ end: jest.fn() }) },
      storage: {
        allFileIds: async function* () {
          yield* storedKeys
        },
        delete: storageDelete
      },
      contentLocks: { withWrite },
      partialUploadAdmission,
      pendingScenesRepository,
      uploadLimits: { pendingDeploymentTtlMs: TTL_MS }
    } as unknown as Components)
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  describe('and some of the given keys are referenced', () => {
    let removed: number

    beforeEach(async () => {
      referencedKeys = ['kept']
      removed = await contentGc.deleteUnreferenced(['orphan-a', 'kept', 'orphan-b'])
    })

    it('should delete only the unreferenced keys under the exclusive lock and count them', () => {
      expect({ removed, deleted: storageDelete.mock.calls, locks: withWrite.mock.calls.length }).toEqual({
        removed: 2,
        deleted: [[['orphan-a', 'orphan-b']]],
        locks: 1
      })
    })

    it('should keep content held by uploads younger than the pending lifetime', () => {
      expect(pendingScenesRepository.getReferencedContentKeys.mock.calls[0][0]).toEqual(new Date(NOW - TTL_MS))
    })
  })

  describe('and more keys than one batch are given', () => {
    beforeEach(async () => {
      await contentGc.deleteUnreferenced(Array.from({ length: 2001 }, (_, i) => `key-${i}`))
    })

    it('should check and delete them in batches of a thousand, each under its own lock', () => {
      expect({
        locks: withWrite.mock.calls.length,
        batches: storageDelete.mock.calls.map(([keys]) => keys.length)
      }).toEqual({ locks: 3, batches: [1000, 1000, 1] })
    })
  })

  describe('and every given key is referenced', () => {
    beforeEach(async () => {
      referencedKeys = ['kept']
      await contentGc.deleteUnreferenced(['kept'])
    })

    it('should not touch storage', () => {
      expect(storageDelete).not.toHaveBeenCalled()
    })
  })

  describe('and the whole storage is swept', () => {
    let result: GarbageCollection

    beforeEach(async () => {
      storedKeys = ['orphan', 'kept']
      referencedKeys = ['kept']
      pendingScenesRepository.listExpired.mockResolvedValueOnce([{ entityId: 'expired', createdAt: '2027-01-01' }])
      pendingScenesRepository.getUploadKeys.mockResolvedValueOnce(['expired', 'expired.auth'])
      result = await contentGc.collectGarbage()
    })

    it('should return the removed keys and the expired-upload cleanup summary', () => {
      expect(result).toEqual({ removed: 1, expiredUploads: { outcome: 'success', removed: 1, failed: 0 } })
    })

    it('should count the removed keys of the sweep only', () => {
      expect(increment.mock.calls.filter(([metric]) => metric === 'garbage_collection_removed_keys')).toEqual([
        ['garbage_collection_removed_keys', {}, 1]
      ])
    })

    it('should reclaim the expired upload after the sweep, deleting its objects before releasing it', () => {
      expect(calls).toEqual(['delete:orphan', 'delete:expired,expired.auth', 'release:expired'])
    })

    it('should log the finished collection', () => {
      expect(info).toHaveBeenCalledWith('Garbage collection finished', { removed: 1, expiredUploads: 'success' })
    })
  })

  describe('and uploads keep the content lock busy during the sweep', () => {
    let error: unknown

    beforeEach(async () => {
      storedKeys = ['orphan']
      withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      error = await contentGc.collectGarbage().catch((e: unknown) => e)
    })

    it('should rethrow without running the expired-upload cleanup', () => {
      expect({
        deferred: error instanceof ContentLockTimeoutError,
        listed: pendingScenesRepository.listExpired.mock.calls.length
      }).toEqual({ deferred: true, listed: 0 })
    })
  })

  describe('and an expired-upload cleanup runs', () => {
    beforeEach(async () => {
      await contentGc.deleteExpiredUploads()
    })

    it('should record that the cleanup finished', () => {
      expect(partialUploadAdmission.recordCleanupFinished).toHaveBeenCalledTimes(1)
    })
  })
})
