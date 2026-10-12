import {
  CLEANUP_MAX_UPLOADS_PER_RUN,
  CLEANUP_PAGE_SIZE,
  createPendingScenesManager
} from '../../src/adapters/pending-scenes-manager'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { ExpiredUploadsCleanup, IPendingScenesManager } from '../../src/adapters/pending-scenes-manager/types'

const NOW = 1_800_000_000_000
const MAX_PENDING_BYTES = 5000

type Statement = string | { text: string; values?: unknown[] }
type ExpiredRow = { entity_id: string; cursor: string }

type Mocks = {
  increment: jest.Mock
  observe: jest.Mock
  endTimer: jest.Mock
  query: jest.Mock
  withWrite: jest.Mock
  storageDelete: jest.Mock
  logError: jest.Mock
  // Pages answered to successive expired-upload listings; empty once exhausted.
  pages: ExpiredRow[][]
}

function statementText(sql: Statement): string {
  return typeof sql === 'string' ? sql : sql.text
}

function expiredRows(prefix: string, count: number): ExpiredRow[] {
  return Array.from({ length: count }, (_, i) => ({
    entity_id: `${prefix}-${String(i).padStart(3, '0')}`,
    cursor: `2027-01-01 00:00:00.${String(i).padStart(6, '0')}+00`
  }))
}

// Answers the cleanup's queries: listing pages, the upload's own key, then the totals.
function answerSweep(mocks: Mocks): (sql: Statement) => Promise<unknown> {
  return (sql) => {
    const text = statementText(sql)
    if (text.includes('ORDER BY created_at, entity_id')) {
      return Promise.resolve({ rows: mocks.pages.shift() ?? [] })
    }
    if (text.includes('SELECT hash FROM pending_scene_files')) {
      return Promise.resolve({ rows: [{ hash: (sql as { values: unknown[] }).values[0] }] })
    }
    if (text.includes('AS bytes')) {
      return Promise.resolve({ rows: [{ bytes: '300', expired: '100' }] })
    }
    if (text.includes('AS live')) {
      return Promise.resolve({ rows: [{ live: '2', expired: '1' }] })
    }
    return Promise.resolve({ rows: [] })
  }
}

function buildMocks(): Mocks {
  const mocks: Mocks = {
    increment: jest.fn(),
    observe: jest.fn(),
    endTimer: jest.fn(),
    query: jest.fn(),
    withWrite: jest.fn((operation: () => Promise<unknown>) => operation()),
    storageDelete: jest.fn().mockResolvedValue(undefined),
    logError: jest.fn(),
    pages: [expiredRows('expired', 1)]
  }
  mocks.query.mockImplementation(answerSweep(mocks))
  return mocks
}

function build(mocks: Mocks): Promise<IPendingScenesManager> {
  return createPendingScenesManager({
    config: {
      getNumber: jest.fn(async (key: string) =>
        key === 'MAX_PENDING_BYTES' || key === 'MAX_PENDING_BYTES_PER_DEPLOYER' ? MAX_PENDING_BYTES : undefined
      )
    },
    database: { query: mocks.query },
    logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: mocks.logError, debug: jest.fn() }) },
    metrics: {
      increment: mocks.increment,
      observe: mocks.observe,
      startTimer: jest.fn().mockReturnValue({ end: mocks.endTimer })
    },
    storage: { delete: mocks.storageDelete },
    contentLocks: { withWrite: mocks.withWrite }
  } as any)
}

function callsOf(mock: jest.Mock, name: string): unknown[] {
  return mock.mock.calls.filter(([metric]) => metric === name)
}

function statementsMatching(mocks: Mocks, fragment: string): { text: string; values?: unknown[] }[] {
  return mocks.query.mock.calls
    .map(([sql]) => (typeof sql === 'string' ? { text: sql } : sql))
    .filter((sql) => sql.text.includes(fragment))
}

// Entity ids whose pending_scenes row the cleanup released.
function released(mocks: Mocks): unknown[] {
  return statementsMatching(mocks, 'DELETE FROM pending_scenes WHERE entity_id').map((sql) => sql.values?.[0])
}

// Which housekeeping steps ran: receipt pruning, rate-window pruning and the gauges.
function housekeeping(mocks: Mocks) {
  return {
    receipts: statementsMatching(mocks, 'DELETE FROM completed_scene_uploads').length,
    rates: statementsMatching(mocks, 'DELETE FROM partial_upload_rates').length,
    gauges: [
      ...callsOf(mocks.observe, 'partial_upload_reserved_bytes'),
      ...callsOf(mocks.observe, 'partial_upload_cleanup_backlog_bytes'),
      ...callsOf(mocks.observe, 'partial_uploads_pending')
    ]
  }
}

const HOUSEKEEPING_RAN = {
  receipts: 1,
  rates: 1,
  gauges: [
    ['partial_upload_reserved_bytes', {}, 300],
    ['partial_upload_cleanup_backlog_bytes', {}, 100],
    ['partial_uploads_pending', { state: 'live' }, 2],
    ['partial_uploads_pending', { state: 'expired' }, 1]
  ]
}

describe('when creating the pending scenes manager', () => {
  let mocks: Mocks

  beforeEach(async () => {
    mocks = buildMocks()
    await build(mocks)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should report the server-wide staging cap', () => {
    expect(mocks.observe).toHaveBeenCalledWith('partial_upload_capacity_bytes', {}, MAX_PENDING_BYTES)
  })
})

describe('when deleting expired partial uploads', () => {
  let mocks: Mocks
  let manager: IPendingScenesManager

  beforeEach(async () => {
    mocks = buildMocks()
    manager = await build(mocks)
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  describe('and every expired upload is reclaimed', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      result = await manager.deleteExpired()
    })

    it('should report a clean run that reclaimed the upload', () => {
      expect({ result, released: released(mocks) }).toEqual({
        result: { outcome: 'success', removed: 1, failed: 0 },
        released: ['expired-000']
      })
    })

    it('should count a successful, timed run, record when it succeeded and count the reclaimed upload', () => {
      expect({
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        lastSuccess: callsOf(mocks.observe, 'partial_upload_cleanup_last_success_timestamp_seconds'),
        expired: callsOf(mocks.increment, 'partial_upload_expired_uploads'),
        timed: mocks.endTimer.mock.calls.length
      }).toEqual({
        runs: [['partial_upload_cleanup_runs', { outcome: 'success' }]],
        lastSuccess: [['partial_upload_cleanup_last_success_timestamp_seconds', {}, NOW / 1000]],
        expired: [['partial_upload_expired_uploads']],
        timed: 1
      })
    })

    it('should prune receipts and rate windows and report the uploads left in the database', () => {
      expect(housekeeping(mocks)).toEqual(HOUSEKEEPING_RAN)
    })
  })

  describe('and deleting the first expired upload from storage fails', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      mocks.pages = [expiredRows('expired', 2)]
      mocks.storageDelete.mockRejectedValueOnce(new Error('storage unavailable'))
      result = await manager.deleteExpired()
    })

    it('should still reclaim the next upload and keep the failed one charged', () => {
      expect({ result, released: released(mocks) }).toEqual({
        result: { outcome: 'error', removed: 1, failed: 1 },
        released: ['expired-001']
      })
    })

    it('should log and count the failed upload', () => {
      expect({
        logged: mocks.logError.mock.calls,
        failures: callsOf(mocks.increment, 'partial_upload_cleanup_failed_uploads')
      }).toEqual({
        logged: [['Failed to reclaim expired upload', { entityId: 'expired-000', error: 'storage unavailable' }]],
        failures: [['partial_upload_cleanup_failed_uploads']]
      })
    })

    it('should count a failed run without recording a success', () => {
      expect({
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        lastSuccess: callsOf(mocks.observe, 'partial_upload_cleanup_last_success_timestamp_seconds')
      }).toEqual({ runs: [['partial_upload_cleanup_runs', { outcome: 'error' }]], lastSuccess: [] })
    })

    it('should still prune receipts and rate windows and refresh the gauges', () => {
      expect(housekeeping(mocks)).toEqual(HOUSEKEEPING_RAN)
    })
  })

  describe('and uploads keep the content lock busy', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      mocks.pages = [expiredRows('expired', 2)]
      mocks.withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      result = await manager.deleteExpired()
    })

    it('should stop without touching the later uploads', () => {
      expect({
        result,
        released: released(mocks),
        keysRead: statementsMatching(mocks, 'SELECT hash FROM pending_scene_files').length
      }).toEqual({ result: { outcome: 'deferred', removed: 0, failed: 0 }, released: [], keysRead: 1 })
    })

    it('should count a deferred run without recording a success', () => {
      expect({
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        lastSuccess: callsOf(mocks.observe, 'partial_upload_cleanup_last_success_timestamp_seconds'),
        logged: mocks.logError.mock.calls
      }).toEqual({ runs: [['partial_upload_cleanup_runs', { outcome: 'deferred' }]], lastSuccess: [], logged: [] })
    })

    it('should still prune receipts and rate windows and refresh the gauges', () => {
      expect(housekeeping(mocks)).toEqual(HOUSEKEEPING_RAN)
    })
  })

  describe('and every upload of the first page fails', () => {
    let result: ExpiredUploadsCleanup
    let listings: { text: string; values?: unknown[] }[]
    let firstPage: ExpiredRow[]

    beforeEach(async () => {
      firstPage = expiredRows('failing', CLEANUP_PAGE_SIZE)
      // Full pages beyond the cap, so only the cap ends the run.
      mocks.pages = [
        firstPage,
        ...Array.from({ length: CLEANUP_MAX_UPLOADS_PER_RUN / CLEANUP_PAGE_SIZE }, (_, page) =>
          expiredRows(`page-${page + 2}`, CLEANUP_PAGE_SIZE)
        )
      ]
      mocks.storageDelete.mockImplementation(async (keys: string[]) => {
        if (keys.some((key) => key.startsWith('failing-'))) throw new Error('storage unavailable')
      })
      result = await manager.deleteExpired()
      listings = statementsMatching(mocks, 'ORDER BY created_at, entity_id')
    })

    it('should page past the failed uploads and reclaim the later ones up to the per-run cap', () => {
      expect(result).toEqual({
        outcome: 'error',
        removed: CLEANUP_MAX_UPLOADS_PER_RUN - CLEANUP_PAGE_SIZE,
        failed: CLEANUP_PAGE_SIZE
      })
    })

    it('should stop listing once the cap is reached', () => {
      expect(listings).toHaveLength(CLEANUP_MAX_UPLOADS_PER_RUN / CLEANUP_PAGE_SIZE)
    })

    it('should resume the second page after the last upload of the first', () => {
      const last = firstPage[firstPage.length - 1]
      expect(listings[1].values).toEqual([new Date(NOW - 60 * 60 * 1000), last.cursor, last.entity_id, 100])
    })
  })

  describe('and listing the expired uploads fails', () => {
    let result: ExpiredUploadsCleanup

    beforeEach(async () => {
      mocks.query.mockRejectedValueOnce(new Error('database is down'))
      result = await manager.deleteExpired()
    })

    it('should report a failed run and still prune receipts and rate windows and refresh the gauges', () => {
      expect({
        result,
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        housekeeping: housekeeping(mocks)
      }).toEqual({
        result: { outcome: 'error', removed: 0, failed: 0 },
        runs: [['partial_upload_cleanup_runs', { outcome: 'error' }]],
        housekeeping: HOUSEKEEPING_RAN
      })
    })
  })

  describe('and pruning completion receipts fails', () => {
    let error: unknown

    beforeEach(async () => {
      const answer = answerSweep(mocks)
      mocks.query.mockImplementation((sql: Statement) =>
        statementText(sql).includes('DELETE FROM completed_scene_uploads')
          ? Promise.reject(new Error('database is down'))
          : answer(sql)
      )
      error = await manager.deleteExpired().catch((e) => e)
    })

    it('should rethrow after counting a failed run without recording a success', () => {
      expect({
        error,
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        lastSuccess: callsOf(mocks.observe, 'partial_upload_cleanup_last_success_timestamp_seconds')
      }).toEqual({
        error: new Error('database is down'),
        runs: [['partial_upload_cleanup_runs', { outcome: 'error' }]],
        lastSuccess: []
      })
    })
  })
})
