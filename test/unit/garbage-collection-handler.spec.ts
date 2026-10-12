import {
  GC_DEFERRED_RETRY_AFTER_SECONDS,
  garbageCollectionHandler
} from '../../src/controllers/handlers/garbage-collection'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { ExpiredUploadsCleanup } from '../../src/logic/content-gc'

type Context = Parameters<typeof garbageCollectionHandler>[0]

const NOW = 1_800_000_000_000

function buildContext(increment: jest.Mock, observe: jest.Mock, collectGarbage: jest.Mock): Context {
  return {
    components: {
      contentGc: { collectGarbage },
      metrics: { increment, observe, startTimer: jest.fn().mockReturnValue({ end: jest.fn() }) }
    }
  } as unknown as Context
}

function callsOf(mock: jest.Mock, name: string): unknown[] {
  return mock.mock.calls.filter(([metric]) => metric === name)
}

describe('when running garbage collection', () => {
  let increment: jest.Mock
  let observe: jest.Mock
  let collectGarbage: jest.Mock

  beforeEach(() => {
    increment = jest.fn()
    observe = jest.fn()
    collectGarbage = jest.fn()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  describe('and it deletes an unreferenced key', () => {
    beforeEach(async () => {
      collectGarbage.mockResolvedValueOnce({
        removed: 1,
        expiredUploads: { outcome: 'success', removed: 0, failed: 0 } satisfies ExpiredUploadsCleanup
      })
      await garbageCollectionHandler(buildContext(increment, observe, collectGarbage))
    })

    it('should count a successful run and record when it succeeded', () => {
      expect({
        runs: callsOf(increment, 'garbage_collection_runs'),
        lastSuccess: callsOf(observe, 'garbage_collection_last_success_timestamp_seconds')
      }).toEqual({
        runs: [['garbage_collection_runs', { outcome: 'success' }]],
        lastSuccess: [['garbage_collection_last_success_timestamp_seconds', {}, NOW / 1000]]
      })
    })
  })

  describe('and the expired-upload cleanup fails to reclaim an upload', () => {
    let response: Awaited<ReturnType<typeof garbageCollectionHandler>>

    beforeEach(async () => {
      collectGarbage.mockResolvedValueOnce({
        removed: 1,
        expiredUploads: { outcome: 'error', removed: 2, failed: 1 } satisfies ExpiredUploadsCleanup
      })
      response = await garbageCollectionHandler(buildContext(increment, observe, collectGarbage))
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
    let response: Awaited<ReturnType<typeof garbageCollectionHandler>>
    let lockError: ContentLockTimeoutError

    beforeEach(async () => {
      lockError = new ContentLockTimeoutError()
      collectGarbage.mockRejectedValueOnce(lockError)
      response = await garbageCollectionHandler(buildContext(increment, observe, collectGarbage))
    })

    it('should answer 503 with a retry hint and the lock error message', () => {
      expect({ status: response.status, headers: response.headers, body: response.body }).toEqual({
        status: 503,
        headers: { 'Retry-After': String(GC_DEFERRED_RETRY_AFTER_SECONDS) },
        body: { error: 'Service Unavailable', message: lockError.message }
      })
    })

    it('should count a deferred run without recording a success', () => {
      expect({
        runs: callsOf(increment, 'garbage_collection_runs'),
        lastSuccess: callsOf(observe, 'garbage_collection_last_success_timestamp_seconds')
      }).toEqual({ runs: [['garbage_collection_runs', { outcome: 'deferred' }]], lastSuccess: [] })
    })
  })

  describe('and deleting from storage fails', () => {
    let error: unknown

    beforeEach(async () => {
      collectGarbage.mockRejectedValueOnce(new Error('storage is down'))
      error = await garbageCollectionHandler(buildContext(increment, observe, collectGarbage)).catch((e) => e)
    })

    it('should rethrow after counting a failed run', () => {
      expect({ error, runs: callsOf(increment, 'garbage_collection_runs') }).toEqual({
        error: new Error('storage is down'),
        runs: [['garbage_collection_runs', { outcome: 'error' }]]
      })
    })
  })
})
