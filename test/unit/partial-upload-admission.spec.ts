import { InvalidRequestError } from '@dcl/http-commons'
import { Entity, EntityType } from '@dcl/schemas'
import {
  createPartialUploadAdmission,
  IPartialUploadAdmission,
  PartialUploadExpiredError,
  PartialUploadNotFoundError,
  PartialUploadOwnershipError,
  PartialUploadQuotaExceededError,
  PartialUploadTooLargeError,
  PendingScene,
  UpsertPendingScene
} from '../../src/logic/partial-upload-admission'
import { BudgetTotals, PendingSceneRecord } from '../../src/adapters/pending-scenes-repository'

type Components = Parameters<typeof createPartialUploadAdmission>[0]

const NOW = 1_800_000_000_000
const TTL_MS = 300_000
const CLEANUP_INTERVAL_MS = 120_000

describe('when admitting partial uploads', () => {
  let repository: Record<string, jest.Mock>
  let clientQuery: jest.Mock
  let observe: jest.Mock
  let admission: IPartialUploadAdmission
  let entity: Entity
  let upload: UpsertPendingScene
  let record: PendingSceneRecord

  function totals(overrides: Partial<BudgetTotals>): BudgetTotals {
    return { account: 0n, total: 0n, own: 0n, scene: 0n, accountOldest: null, oldest: null, ...overrides }
  }

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    entity = {
      version: 'v3',
      id: 'entity',
      type: EntityType.SCENE,
      timestamp: NOW,
      pointers: ['0,0'],
      content: [],
      metadata: {}
    }
    upload = {
      entityId: 'entity',
      worldName: 'World.dcl.eth',
      parcels: ['0,0'],
      entity,
      deployer: '0xACCOUNT',
      admittedAt: new Date(NOW - 1_000),
      resumes: false
    }
    record = {
      entityId: 'entity',
      worldName: 'world.dcl.eth',
      parcels: ['0,0'],
      deployer: '0xaccount',
      createdAt: new Date(NOW - 1_000),
      updatedAt: new Date(NOW - 1_000),
      initialized: false
    }
    clientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    observe = jest.fn()
    repository = {
      getCreatedSince: jest.fn().mockResolvedValue(undefined),
      getCompleted: jest.fn().mockResolvedValue(undefined),
      lockDeployer: jest.fn().mockResolvedValue(undefined),
      findRecord: jest.fn().mockResolvedValue(undefined),
      countByDeployer: jest.fn().mockResolvedValue({ count: 0, oldest: null }),
      insert: jest.fn().mockResolvedValue(record),
      getOwner: jest.fn().mockResolvedValue({ deployer: '0xaccount', createdAt: new Date(NOW - 1_000) }),
      chargeByteRate: jest.fn().mockResolvedValue({ bytes: 100n, retryAfterSeconds: 60 }),
      lockBudget: jest.fn().mockResolvedValue(undefined),
      upsertFiles: jest.fn().mockResolvedValue(undefined),
      refreshReservedBytes: jest.fn().mockResolvedValue(undefined),
      getBudgetTotals: jest.fn().mockResolvedValue(totals({ account: 100n, total: 100n, own: 100n, scene: 100n })),
      discardUnadmitted: jest.fn().mockResolvedValue(undefined),
      recordStored: jest.fn().mockResolvedValue(1),
      markMissing: jest.fn().mockResolvedValue(undefined),
      pruneCompleted: jest.fn().mockResolvedValue(undefined),
      pruneByteRates: jest.fn().mockResolvedValue(undefined),
      getChargedBytes: jest.fn().mockResolvedValue({ bytes: 0, expired: 0 }),
      countUploads: jest.fn().mockResolvedValue({ live: 0, expired: 0 })
    }
    admission = await createPartialUploadAdmission({
      database: { getPool: () => ({ connect: async () => ({ query: clientQuery, release: jest.fn() }) }) },
      metrics: { observe },
      pendingScenesRepository: repository,
      uploadLimits: {
        pendingDeploymentTtlMs: TTL_MS,
        partialUploadCleanupIntervalMs: CLEANUP_INTERVAL_MS,
        maxPendingBytesPerDeployer: 600n,
        maxPendingBytes: 1000n,
        maxPartialUploadBytesPerMinute: 500,
        completedUploadTtlMs: 86_400_000,
        maxPendingDeploymentsPerDeployer: 2
      }
    } as unknown as Components)
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  describe('and a live upload is looked up', () => {
    let pending: PendingScene | undefined

    beforeEach(async () => {
      repository.getCreatedSince.mockResolvedValueOnce(record)
      pending = await admission.getByEntityId('entity')
    })

    it('should only accept uploads created within their lifetime', () => {
      expect(repository.getCreatedSince).toHaveBeenCalledWith('entity', new Date(NOW - TTL_MS), undefined)
    })

    it('should report when its lifetime ends', () => {
      expect(pending?.expiresAt).toEqual(new Date(record.createdAt.getTime() + TTL_MS))
    })
  })

  describe('and a completion receipt is looked up', () => {
    beforeEach(async () => {
      await admission.getCompleted('entity', '0xACCOUNT')
    })

    it('should look it up for the lowercased deployer among unexpired receipts', () => {
      expect(repository.getCompleted).toHaveBeenCalledWith('entity', '0xaccount', new Date(NOW - 86_400_000), undefined)
    })
  })

  describe('and an upload is created', () => {
    let pending: PendingScene

    beforeEach(async () => {
      pending = await admission.upsert(upload)
    })

    it('should store it for the lowercased deployer and world, created at its admission', () => {
      expect(repository.insert.mock.calls[0][1]).toEqual({
        entityId: 'entity',
        worldName: 'world.dcl.eth',
        parcels: ['0,0'],
        entity,
        deployer: '0xaccount',
        createdAt: upload.admittedAt
      })
    })

    it('should take the deployer lock before reading the upload', () => {
      expect(repository.lockDeployer.mock.invocationCallOrder[0]).toBeLessThan(
        repository.findRecord.mock.invocationCallOrder[0]
      )
    })

    it('should run every statement in the same transaction', () => {
      const [[query]] = repository.lockDeployer.mock.calls
      expect({
        query: typeof query,
        findRecord: repository.findRecord.mock.calls[0][0],
        countByDeployer: repository.countByDeployer.mock.calls[0][0],
        insert: repository.insert.mock.calls[0][0]
      }).toEqual({ query: 'function', findRecord: query, countByDeployer: query, insert: query })
    })

    it('should return it with its expiry', () => {
      expect(pending.expiresAt).toEqual(new Date(record.createdAt.getTime() + TTL_MS))
    })
  })

  describe('and the upload was started by another account', () => {
    let error: unknown

    beforeEach(async () => {
      repository.findRecord.mockResolvedValueOnce({ ...record, deployer: '0xother' })
      error = await admission.upsert(upload).catch((e: unknown) => e)
    })

    it('should reject it as an invalid request from another account', () => {
      expect({
        typed: error instanceof PartialUploadOwnershipError,
        invalid: error instanceof InvalidRequestError,
        message: (error as Error).message
      }).toEqual({ typed: true, invalid: true, message: 'This upload was started by another account.' })
    })
  })

  describe('and the existing upload is past its lifetime', () => {
    let error: unknown

    beforeEach(async () => {
      repository.findRecord.mockResolvedValueOnce({ ...record, createdAt: new Date(NOW - TTL_MS - 1) })
      error = await admission.upsert(upload).catch((e: unknown) => e)
    })

    it('should reject the batch as expired', () => {
      expect(error).toBeInstanceOf(PartialUploadExpiredError)
    })
  })

  describe('and a resumed upload is gone', () => {
    let error: unknown

    beforeEach(async () => {
      error = await admission.upsert({ ...upload, resumes: true }).catch((e) => e)
    })

    it('should reject the batch as expired without creating the upload', () => {
      expect({ expired: error instanceof PartialUploadExpiredError, inserts: repository.insert.mock.calls }).toEqual({
        expired: true,
        inserts: []
      })
    })
  })

  describe('and a new upload is admitted after its lifetime', () => {
    let error: unknown

    beforeEach(async () => {
      upload.admittedAt = new Date(NOW - TTL_MS - 1)
      error = await admission.upsert(upload).catch((e: unknown) => e)
    })

    it('should reject the batch as expired', () => {
      expect(error).toBeInstanceOf(PartialUploadExpiredError)
    })
  })

  describe('and the account has its maximum of uploads', () => {
    let error: unknown

    beforeEach(async () => {
      repository.countByDeployer.mockResolvedValueOnce({ count: 2, oldest: new Date(NOW - 60_000) })
      error = await admission.upsert(upload).catch((e: unknown) => e)
    })

    it('should reject with the upload-count quota, retrying when its oldest upload expires', () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'uploads_per_account',
        message:
          'Too many partial uploads in progress for this account: 2 of the 2 allowed. Complete an upload or wait for expired uploads to be cleaned up.',
        retryAfter: 240
      })
    })
  })

  describe('and a batch is reserved for an upload that no longer exists', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getOwner.mockResolvedValueOnce(undefined)
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should ask for the manifest again as an invalid request', () => {
      expect({
        typed: error instanceof PartialUploadNotFoundError,
        invalid: error instanceof InvalidRequestError,
        message: (error as Error).message
      }).toEqual({ typed: true, invalid: true, message: 'Upload no longer exists; resend its manifest.' })
    })
  })

  describe('and a batch is reserved for an upload past its lifetime', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getOwner.mockResolvedValueOnce({ deployer: '0xaccount', createdAt: new Date(NOW - TTL_MS - 1) })
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should reject it as expired without charging the byte rate', () => {
      expect({
        expired: error instanceof PartialUploadExpiredError,
        charged: repository.chargeByteRate.mock.calls
      }).toEqual({ expired: true, charged: [] })
    })
  })

  describe('and a batch alone exceeds the per-minute byte rate', () => {
    let error: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockResolvedValueOnce({ bytes: 501n, retryAfterSeconds: 60 })
      error = await admission.reserve('entity', [], 1000n, 501).catch((e: unknown) => e)
    })

    it('should reject it as too large for the byte rate', () => {
      expect({
        tooLarge: error instanceof PartialUploadTooLargeError,
        quota: (error as PartialUploadTooLargeError).quota,
        message: (error as Error).message
      }).toEqual({
        tooLarge: true,
        quota: 'bytes_per_minute',
        message:
          'This batch is 501 bytes, above the partial upload limit of 500 bytes per minute. Send smaller batches.'
      })
    })
  })

  describe("and the account's minute window is over the byte rate", () => {
    let error: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockResolvedValueOnce({ bytes: 600n, retryAfterSeconds: 30 })
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should reject with the byte-rate quota, retrying when the window resets', () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'bytes_per_minute',
        message:
          'This account sent 600 bytes of partial uploads this minute, above the limit of 500 bytes per minute. Retry in 30 s.',
        retryAfter: 30
      })
    })
  })

  describe('and the scene exceeds its size limit', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ scene: 1001n }))
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should reject the scene as too big', () => {
      expect(error).toEqual(new InvalidRequestError('Deployment failed: The deployment is too big.'))
    })
  })

  describe('and the upload alone exceeds the account byte budget', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ own: 700n, account: 700n, total: 700n }))
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should reject it as too large for the account budget', () => {
      expect({
        tooLarge: error instanceof PartialUploadTooLargeError,
        quota: (error as PartialUploadTooLargeError).quota,
        message: (error as Error).message
      }).toEqual({
        tooLarge: true,
        quota: 'bytes_per_account',
        message:
          'This upload needs 700 bytes of staging, above the per-account partial upload limit of 600 bytes. Reduce its size.'
      })
    })
  })

  describe("and the account's uploads exceed its byte budget", () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(
        totals({ own: 300n, account: 700n, total: 700n, accountOldest: new Date(NOW - 100_000) })
      )
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it("should reject with the account byte quota, retrying when the account's oldest charged upload expires", () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'bytes_per_account',
        message:
          'This batch would stage 700 bytes for this account, above its limit of 600 bytes. Complete an upload or wait for expired uploads to be cleaned up.',
        retryAfter: 200
      })
    })
  })

  describe("and the server's uploads exceed its byte budget", () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(
        totals({ own: 300n, account: 300n, total: 1001n, oldest: new Date(NOW - 50_000) })
      )
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it("should reject with the server byte quota, retrying when the server's oldest charged upload expires", () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'bytes_per_server',
        message: 'This batch would stage 1001 bytes on the server, above its limit of 1000 bytes. Retry later.',
        retryAfter: 250
      })
    })
  })

  describe('and the oldest charged upload has expired after a cleanup finished 50 seconds ago', () => {
    let error: unknown

    beforeEach(async () => {
      admission.recordCleanupFinished()
      ;(Date.now as jest.Mock).mockReturnValue(NOW + 50_000)
      repository.getOwner.mockResolvedValueOnce({ deployer: '0xaccount', createdAt: new Date(NOW) })
      repository.getBudgetTotals.mockResolvedValueOnce(
        totals({ own: 300n, account: 300n, total: 1001n, oldest: new Date(NOW - TTL_MS) })
      )
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should retry when the next cleanup runs', () => {
      expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(70)
    })
  })

  describe('and the account has one upload fewer than its maximum', () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.countByDeployer.mockResolvedValueOnce({ count: 1, oldest: new Date(NOW - 60_000) })
      outcome = await admission.upsert(upload).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the new upload', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe('and a batch is exactly at the per-minute byte rate', () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockResolvedValueOnce({ bytes: 500n, retryAfterSeconds: 60 })
      outcome = await admission.reserve('entity', [], 1000n, 500).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the batch', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe("and the account's minute window reaches exactly the byte rate", () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockResolvedValueOnce({ bytes: 500n, retryAfterSeconds: 30 })
      outcome = await admission.reserve('entity', [], 1000n, 100).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the batch', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe('and the scene is exactly at its size limit', () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ own: 100n, account: 100n, total: 100n, scene: 1000n }))
      outcome = await admission.reserve('entity', [], 1000n, 100).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the batch', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe('and the account byte budget is exactly full', () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ own: 600n, account: 600n, total: 600n, scene: 600n }))
      outcome = await admission.reserve('entity', [], 1000n, 100).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the batch', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe('and the server byte budget is exactly full', () => {
    let outcome: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ own: 100n, account: 100n, total: 1000n, scene: 100n }))
      outcome = await admission.reserve('entity', [], 1000n, 100).then(
        () => 'admitted',
        (e: unknown) => e
      )
    })

    it('should admit the batch', () => {
      expect(outcome).toBe('admitted')
    })
  })

  describe('and the oldest charged upload expires in a fraction of a second over a whole number', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(
        totals({ own: 300n, account: 300n, total: 1001n, oldest: new Date(NOW - 60_900) })
      )
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should round the retry up to the next second', () => {
      expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(240)
    })
  })

  describe('and the oldest charged upload has expired and the next cleanup is overdue', () => {
    let error: unknown

    beforeEach(async () => {
      admission.recordCleanupFinished()
      ;(Date.now as jest.Mock).mockReturnValue(NOW + CLEANUP_INTERVAL_MS + 10_000)
      repository.getOwner.mockResolvedValueOnce({ deployer: '0xaccount', createdAt: new Date(NOW) })
      repository.getBudgetTotals.mockResolvedValueOnce(
        totals({ own: 300n, account: 300n, total: 1001n, oldest: new Date(NOW - TTL_MS) })
      )
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should retry after one second', () => {
      expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(1)
    })
  })

  describe('and no charged upload is known and no cleanup has finished yet', () => {
    let error: unknown

    beforeEach(async () => {
      repository.getBudgetTotals.mockResolvedValueOnce(totals({ own: 300n, account: 300n, total: 1001n, oldest: null }))
      error = await admission.reserve('entity', [], 1000n, 100).catch((e: unknown) => e)
    })

    it('should retry after one cleanup interval', () => {
      expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(CLEANUP_INTERVAL_MS / 1000)
    })
  })

  describe('and a batch fits every budget', () => {
    beforeEach(async () => {
      await admission.reserve('entity', [{ hash: 'a', size: 100, stored: false, charged: true }], 1000n, 100)
    })

    it('should take the budget lock before merging its files', () => {
      expect(repository.lockBudget.mock.invocationCallOrder[0]).toBeLessThan(
        repository.upsertFiles.mock.invocationCallOrder[0]
      )
    })

    it('should run every statement in the same transaction', () => {
      const [[query]] = repository.lockBudget.mock.calls
      expect({
        query: typeof query,
        upsertFiles: repository.upsertFiles.mock.calls[0][0],
        refreshReservedBytes: repository.refreshReservedBytes.mock.calls[0][0],
        getBudgetTotals: repository.getBudgetTotals.mock.calls[0][0]
      }).toEqual({ query: 'function', upsertFiles: query, refreshReservedBytes: query, getBudgetTotals: query })
    })

    it('should report the reserved bytes', () => {
      expect(observe).toHaveBeenCalledWith('partial_upload_reserved_bytes', {}, 100)
    })
  })

  describe('and a batch has no receipts', () => {
    beforeEach(async () => {
      await admission.reserve('entity', [], 1000n, 0)
    })

    it('should not merge any file', () => {
      expect(repository.upsertFiles).not.toHaveBeenCalled()
    })
  })

  describe('and the first batch of a new upload is admitted', () => {
    let pending: PendingScene

    beforeEach(async () => {
      pending = await admission.admitBatch({ upload, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
    })

    it('should return the created upload', () => {
      expect(pending.entityId).toBe('entity')
    })

    it('should keep the upload', () => {
      expect(repository.discardUnadmitted).not.toHaveBeenCalled()
    })
  })

  describe('and the account has the configured maximum of uploads when a new upload is admitted', () => {
    let error: unknown

    beforeEach(async () => {
      repository.countByDeployer.mockResolvedValueOnce({ count: 2, oldest: new Date(NOW - 60_000) })
      error = await admission
        .admitBatch({ upload, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
        .catch((e: unknown) => e)
    })

    it('should reject with the upload-count quota', () => {
      expect((error as PartialUploadQuotaExceededError).quota).toBe('uploads_per_account')
    })
  })

  describe('and the first batch of a new upload is not admitted', () => {
    let error: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockRejectedValueOnce(new Error('budget exceeded'))
      error = await admission
        .admitBatch({ upload, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
        .catch((e: unknown) => e)
    })

    it('should discard the upload it created so it does not hold a slot of the cap', () => {
      expect({ error, discarded: repository.discardUnadmitted.mock.calls }).toEqual({
        error: new Error('budget exceeded'),
        discarded: [['entity']]
      })
    })
  })

  describe('and discarding a rejected first batch fails', () => {
    let error: unknown

    beforeEach(async () => {
      repository.chargeByteRate.mockRejectedValueOnce(new Error('budget exceeded'))
      repository.discardUnadmitted.mockRejectedValueOnce(new Error('database down'))
      error = await admission
        .admitBatch({ upload, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
        .catch((e: unknown) => e)
    })

    it('should still reject with the admission error', () => {
      expect(error).toEqual(new Error('budget exceeded'))
    })
  })

  describe('and a later batch of an upload is not admitted', () => {
    beforeEach(async () => {
      repository.findRecord.mockResolvedValueOnce(record)
      repository.chargeByteRate.mockRejectedValueOnce(new Error('rate exceeded'))
      await admission
        .admitBatch({ upload: { ...upload, resumes: true }, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
        .catch(() => undefined)
    })

    it('should keep the existing upload', () => {
      expect(repository.discardUnadmitted).not.toHaveBeenCalled()
    })
  })

  describe('and the upload of a new batch is rejected', () => {
    beforeEach(async () => {
      repository.findRecord.mockResolvedValueOnce({ ...record, deployer: '0xother' })
      await admission
        .admitBatch({ upload, receipts: [], maxSceneBytes: 1000n, incomingBytes: 100 })
        .catch(() => undefined)
    })

    it('should neither reserve nor discard anything', () => {
      expect({
        charged: repository.chargeByteRate.mock.calls.length,
        discarded: repository.discardUnadmitted.mock.calls.length
      }).toEqual({ charged: 0, discarded: 0 })
    })
  })

  describe('and stored writes are recorded', () => {
    let batches: number

    beforeEach(async () => {
      batches = await admission.recordStored('entity', ['a'])
    })

    it('should record them inside a committed transaction', () => {
      expect({
        batches,
        statements: clientQuery.mock.calls.map(([sql]) => (typeof sql === 'string' ? sql : 'statement'))
      }).toEqual({ batches: 1, statements: ['BEGIN', 'statement', 'COMMIT'] })
    })
  })
})
