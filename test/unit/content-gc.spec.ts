import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import {
  createContentGcComponent,
  EXPIRY_CLOCK_SKEW_GRACE_MS,
  ExpiredUploadsCleanup,
  GarbageCollection,
  IContentGcComponent
} from '../../src/logic/content-gc'

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

    it('should keep content held by uploads younger than the pending lifetime plus the clock-skew grace', () => {
      expect(pendingScenesRepository.getReferencedContentKeys.mock.calls[0][0]).toEqual(
        new Date(NOW - TTL_MS - EXPIRY_CLOCK_SKEW_GRACE_MS)
      )
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

    it('should list and release only uploads expired for longer than the clock-skew grace', () => {
      expect({
        listed: pendingScenesRepository.listExpired.mock.calls[0][0],
        released: pendingScenesRepository.releaseExpired.mock.calls[0][1]
      }).toEqual({
        listed: new Date(NOW - TTL_MS - EXPIRY_CLOCK_SKEW_GRACE_MS),
        released: new Date(NOW - TTL_MS - EXPIRY_CLOCK_SKEW_GRACE_MS)
      })
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

  describe('and the storage holds one key more than a batch', () => {
    beforeEach(async () => {
      storedKeys = Array.from({ length: 1001 }, (_, i) => `key-${i}`)
      await contentGc.collectGarbage()
    })

    it('should take the exclusive lock once per batch', () => {
      expect(withWrite).toHaveBeenCalledTimes(2)
    })

    it('should delete a full batch and then the remainder', () => {
      expect(storageDelete.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1])
    })
  })

  describe('and the content lock times out after an earlier upload failed to be reclaimed', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      pendingScenesRepository.listExpired.mockResolvedValueOnce([
        { entityId: 'failing', createdAt: '2027-01-01' },
        { entityId: 'busy', createdAt: '2027-01-01' }
      ])
      pendingScenesRepository.getUploadKeys
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValueOnce(['busy'])
      withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      result = await contentGc.deleteExpiredUploads()
    })

    it('should report the run as an error rather than deferred', () => {
      expect(result).toEqual({ outcome: 'error', removed: 0, failed: 1 })
    })

    it('should count the run as an error', () => {
      expect(increment).toHaveBeenCalledWith('partial_upload_cleanup_runs', { outcome: 'error' })
    })
  })

  describe('and a cleanup run throws while another run is queued behind it', () => {
    let firstError: unknown
    let second: ExpiredUploadsCleanup

    beforeEach(async () => {
      partialUploadAdmission.pruneAndReport.mockRejectedValueOnce(new Error('prune failed'))
      const first = contentGc.deleteExpiredUploads()
      const queued = contentGc.deleteExpiredUploads()
      firstError = await first.catch((e: unknown) => e)
      second = await queued
    })

    it('should reject the failed run with its error', () => {
      expect(firstError).toEqual(new Error('prune failed'))
    })

    it('should still run the queued cleanup', () => {
      expect(second).toEqual({ outcome: 'success', removed: 0, failed: 0 })
    })
  })

  describe('and an expired-upload cleanup run throws', () => {
    beforeEach(async () => {
      partialUploadAdmission.pruneAndReport.mockRejectedValueOnce(new Error('prune failed'))
      await contentGc.deleteExpiredUploads().catch(() => undefined)
    })

    it('should record that the cleanup finished', () => {
      expect(partialUploadAdmission.recordCleanupFinished).toHaveBeenCalledTimes(1)
    })
  })

  describe('and an expired-upload cleanup run is deferred by a busy content lock', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      pendingScenesRepository.listExpired.mockResolvedValueOnce([{ entityId: 'busy', createdAt: '2027-01-01' }])
      pendingScenesRepository.getUploadKeys.mockResolvedValueOnce(['busy'])
      withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      result = await contentGc.deleteExpiredUploads()
    })

    it('should report the run as deferred', () => {
      expect(result.outcome).toBe('deferred')
    })

    it('should record that the cleanup finished', () => {
      expect(partialUploadAdmission.recordCleanupFinished).toHaveBeenCalledTimes(1)
    })
  })
})
