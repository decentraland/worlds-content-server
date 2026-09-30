import { createPendingScenesManager } from '../../src/adapters/pending-scenes-manager'
import { ContentLockTimeoutError } from '../../src/adapters/content-locks/errors'
import { IPendingScenesManager } from '../../src/adapters/pending-scenes-manager/types'

const NOW = 1_800_000_000_000
const MAX_PENDING_BYTES = 5000

type Mocks = {
  increment: jest.Mock
  observe: jest.Mock
  endTimer: jest.Mock
  query: jest.Mock
  withWrite: jest.Mock
}

function statementText(sql: string | { text: string }): string {
  return typeof sql === 'string' ? sql : sql.text
}

// Answers the sweep's queries: one expired upload with one staged key, then the totals.
function answerSweep(sql: string | { text: string }): Promise<unknown> {
  const text = statementText(sql)
  if (text.includes('SELECT entity_id FROM pending_scenes WHERE created_at <')) {
    return Promise.resolve({ rows: [{ entity_id: 'expired-entity' }] })
  }
  if (text.includes('SELECT hash FROM pending_scene_files')) {
    return Promise.resolve({ rows: [{ hash: 'staged-hash' }] })
  }
  if (text.includes('AS bytes')) {
    return Promise.resolve({ rows: [{ bytes: '300', expired: '100' }] })
  }
  if (text.includes('AS live')) {
    return Promise.resolve({ rows: [{ live: '2', expired: '1' }] })
  }
  return Promise.resolve({ rows: [] })
}

function buildMocks(): Mocks {
  const endTimer = jest.fn()
  return {
    increment: jest.fn(),
    observe: jest.fn(),
    endTimer,
    query: jest.fn(answerSweep),
    withWrite: jest.fn()
  }
}

function build(mocks: Mocks): Promise<IPendingScenesManager> {
  return createPendingScenesManager({
    config: {
      getNumber: jest.fn(async (key: string) => (key === 'MAX_PENDING_BYTES' ? MAX_PENDING_BYTES : undefined))
    },
    database: { query: mocks.query },
    logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
    metrics: {
      increment: mocks.increment,
      observe: mocks.observe,
      startTimer: jest.fn().mockReturnValue({ end: mocks.endTimer })
    },
    storage: { delete: jest.fn() },
    contentLocks: { withWrite: mocks.withWrite }
  } as any)
}

function callsOf(mock: jest.Mock, name: string): unknown[] {
  return mock.mock.calls.filter(([metric]) => metric === name)
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
    beforeEach(async () => {
      mocks.withWrite.mockResolvedValue(undefined)
      await manager.deleteExpired()
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

    it('should report the live and expired uploads left in the database', () => {
      expect(callsOf(mocks.observe, 'partial_uploads_pending')).toEqual([
        ['partial_uploads_pending', { state: 'live' }, 2],
        ['partial_uploads_pending', { state: 'expired' }, 1]
      ])
    })
  })

  describe('and uploads keep the content lock busy', () => {
    let error: unknown

    beforeEach(async () => {
      mocks.withWrite.mockRejectedValueOnce(new ContentLockTimeoutError())
      error = await manager.deleteExpired().catch((e) => e)
    })

    it('should rethrow after counting a deferred run without recording a success', () => {
      expect({
        error: error instanceof ContentLockTimeoutError,
        runs: callsOf(mocks.increment, 'partial_upload_cleanup_runs'),
        lastSuccess: callsOf(mocks.observe, 'partial_upload_cleanup_last_success_timestamp_seconds')
      }).toEqual({
        error: true,
        runs: [['partial_upload_cleanup_runs', { outcome: 'deferred' }]],
        lastSuccess: []
      })
    })
  })

  describe('and the database fails', () => {
    let error: unknown

    beforeEach(async () => {
      mocks.query.mockRejectedValueOnce(new Error('database is down'))
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
