import { garbageCollectionHandler } from '../../src/controllers/handlers/garbage-collection'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { ExpiredUploadsCleanup } from '../../src/adapters/pending-scenes-manager/types'

type Context = Parameters<typeof garbageCollectionHandler>[0]

const NOW = 1_800_000_000_000

function buildContext(
  increment: jest.Mock,
  observe: jest.Mock,
  withWrite: jest.Mock,
  cleanup: ExpiredUploadsCleanup = { outcome: 'success', removed: 0, failed: 0 }
): Context {
  return {
    components: {
      database: { query: jest.fn().mockResolvedValue({ rows: [] }) },
      logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
      metrics: { increment, observe, startTimer: jest.fn().mockReturnValue({ end: jest.fn() }) },
      pendingScenesManager: { ttlMs: 60_000, deleteExpired: jest.fn().mockResolvedValue(cleanup) },
      storage: {
        allFileIds: async function* () {
          yield 'unreferenced-key'
        },
        delete: jest.fn()
      },
      contentLocks: { withWrite }
    }
  } as unknown as Context
}

function callsOf(mock: jest.Mock, name: string): unknown[] {
  return mock.mock.calls.filter(([metric]) => metric === name)
}

describe('when running garbage collection', () => {
  let increment: jest.Mock
  let observe: jest.Mock
  let withWrite: jest.Mock

  beforeEach(() => {
    increment = jest.fn()
    observe = jest.fn()
    withWrite = jest.fn()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  describe('and it deletes an unreferenced key', () => {
    beforeEach(async () => {
      withWrite.mockImplementation((operation: () => Promise<unknown>) => operation())
      await garbageCollectionHandler(buildContext(increment, observe, withWrite))
    })

    it('should count the removed key and a successful run and record when it succeeded', () => {
      expect({
        removed: callsOf(increment, 'garbage_collection_removed_keys'),
        runs: callsOf(increment, 'garbage_collection_runs'),
        lastSuccess: callsOf(observe, 'garbage_collection_last_success_timestamp_seconds')
      }).toEqual({
        removed: [['garbage_collection_removed_keys', {}, 1]],
        runs: [['garbage_collection_runs', { outcome: 'success' }]],
        lastSuccess: [['garbage_collection_last_success_timestamp_seconds', {}, NOW / 1000]]
      })
    })
  })

  describe('and the expired-upload cleanup fails to reclaim an upload', () => {
    let response: Awaited<ReturnType<typeof garbageCollectionHandler>>

    beforeEach(async () => {
      withWrite.mockImplementation((operation: () => Promise<unknown>) => operation())
      response = await garbageCollectionHandler(
        buildContext(increment, observe, withWrite, { outcome: 'error', removed: 2, failed: 1 })
      )
    })

    it('should answer the completed sweep with the cleanup summary', () => {
      expect({ status: response.status, body: response.body }).toEqual({
        status: 200,
        body: {
          message: 'Garbage collection removed 1 unused keys.',
          expiredUploads: { outcome: 'error', removed: 2, failed: 1 }
        }
      })
    })

    it('should count a successful garbage collection run', () => {
      expect(callsOf(increment, 'garbage_collection_runs')).toEqual([
        ['garbage_collection_runs', { outcome: 'success' }]
      ])
    })
  })

  describe('and uploads keep the content lock busy', () => {
    let error: unknown

    beforeEach(async () => {
      withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      error = await garbageCollectionHandler(buildContext(increment, observe, withWrite)).catch((e) => e)
    })

    it('should rethrow after counting a deferred run without recording a success', () => {
      expect({
        error: error instanceof ContentLockTimeoutError,
        runs: callsOf(increment, 'garbage_collection_runs'),
        lastSuccess: callsOf(observe, 'garbage_collection_last_success_timestamp_seconds')
      }).toEqual({ error: true, runs: [['garbage_collection_runs', { outcome: 'deferred' }]], lastSuccess: [] })
    })
  })

  describe('and deleting from storage fails', () => {
    let error: unknown

    beforeEach(async () => {
      withWrite.mockRejectedValueOnce(new Error('storage is down'))
      error = await garbageCollectionHandler(buildContext(increment, observe, withWrite)).catch((e) => e)
    })

    it('should rethrow after counting a failed run', () => {
      expect({ error, runs: callsOf(increment, 'garbage_collection_runs') }).toEqual({
        error: new Error('storage is down'),
        runs: [['garbage_collection_runs', { outcome: 'error' }]]
      })
    })
  })
})
