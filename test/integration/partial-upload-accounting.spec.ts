import SQL from 'sql-template-strings'
import { InvalidRequestError } from '@dcl/http-commons'
import { Entity, EntityType } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage'
import { test } from '../components'
import { cleanup, waitForAdvisoryLocks } from '../utils'
import {
  createPartialUploadAdmission,
  IPartialUploadAdmission,
  PartialUploadExpiredError,
  PartialUploadQuotaExceededError,
  PartialUploadTooLargeError
} from '../../src/logic/partial-upload-admission'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES, loadUploadLimits, UploadLimits } from '../../src/logic/upload-limits'
import { createPendingScenesRepository, IPendingScenesRepository } from '../../src/adapters/pending-scenes-repository'
import { CLEANUP_PAGE_SIZE, createContentGcComponent, IContentGcComponent } from '../../src/logic/content-gc'

test('when accounting for independent partial uploads', ({ components }) => {
  let manager: IPartialUploadAdmission
  let repository: IPendingScenesRepository
  let gc: IContentGcComponent
  let first: Entity
  let second: Entity
  let signer: string
  let limits: Record<string, number>
  let uploadLimits: UploadLimits

  async function create(entity: Entity, deployer = signer, admittedAt = new Date(), resumes = false): Promise<void> {
    await manager.upsert({
      entityId: entity.id,
      entity,
      deployer,
      worldName: 'test.dcl.eth',
      parcels: ['0,0'],
      admittedAt,
      resumes
    })
  }

  async function build(overrides: Partial<UploadLimits> = {}): Promise<void> {
    const limitsInUse = { ...uploadLimits, ...overrides }
    manager = await createPartialUploadAdmission({
      database: components.database,
      metrics: components.metrics,
      pendingScenesRepository: repository,
      uploadLimits: limitsInUse
    })
    gc = await createContentGcComponent({
      logs: components.logs,
      metrics: components.metrics,
      storage: components.storage,
      contentLocks: components.contentLocks,
      partialUploadAdmission: manager,
      pendingScenesRepository: repository,
      uploadLimits: limitsInUse
    })
  }

  function settle(results: PromiseSettledResult<unknown>[]): { fulfilled: number; rejections: unknown[] } {
    return {
      fulfilled: results.filter((result) => result.status === 'fulfilled').length,
      rejections: results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    }
  }

  async function pendingCount(): Promise<number> {
    const result = await components.database.query<{ count: string }>('SELECT COUNT(*) AS count FROM pending_scenes')
    return Number(result.rows[0].count)
  }

  beforeEach(async () => {
    limits = {
      MAX_PENDING_BYTES_PER_DEPLOYER: 600,
      MAX_PENDING_BYTES: 1000,
      MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES,
      PENDING_DEPLOYMENT_TTL: 300_000,
      PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS: 120_000
    }
    signer = '0xaccount'
    first = {
      version: 'v3',
      id: 'first',
      type: EntityType.SCENE,
      timestamp: Date.now(),
      pointers: ['0,0'],
      content: [{ hash: 'content-a', file: 'a' }],
      metadata: { worldConfiguration: { name: 'test.dcl.eth' } }
    }
    second = { ...first, id: 'second', content: [{ hash: 'content-b', file: 'b' }] }
    // `components` is a get-only Proxy over an empty target, so it must be read key by key:
    // spreading it reads ownKeys from that empty target and yields nothing.
    // Built directly, bypassing loadUploadLimits' validation on purpose, to use tiny budgets.
    uploadLimits = {
      ...components.uploadLimits,
      maxPendingDeploymentsPerDeployer: 10,
      maxPendingBytesPerDeployer: BigInt(limits.MAX_PENDING_BYTES_PER_DEPLOYER),
      maxPendingBytes: BigInt(limits.MAX_PENDING_BYTES),
      maxPartialUploadBytesPerMinute: limits.MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE,
      pendingDeploymentTtlMs: limits.PENDING_DEPLOYMENT_TTL,
      partialUploadCleanupIntervalMs: limits.PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS
    }
    repository = await createPendingScenesRepository({ database: components.database })
    await build()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanup(components.storage, components.database)
  })

  describe('and a new upload is admitted', () => {
    let admittedAt: Date
    let createdAt: Date | undefined

    beforeEach(async () => {
      admittedAt = new Date(Date.now() - 60_000)
      await create(first, signer, admittedAt)
      createdAt = (await manager.getByEntityId(first.id))?.createdAt
    })

    it('should start its lifetime at the admission instant', () => {
      expect(createdAt).toEqual(admittedAt)
    })
  })

  describe('and an upload the batch saw live was removed by cleanup before it is upserted', () => {
    let upsertError: unknown
    let pending: number

    beforeEach(async () => {
      upsertError = await create(first, signer, new Date(Date.now() - 60_000), true).catch((error: unknown) => error)
      pending = await pendingCount()
    })

    it('should answer that the upload expired', () => {
      expect(upsertError).toBeInstanceOf(PartialUploadExpiredError)
    })

    it('should not recreate the upload', () => {
      expect(pending).toBe(0)
    })
  })

  describe('and the first batch of a new upload is created after its deadline', () => {
    let upsertError: unknown
    let pending: number

    beforeEach(async () => {
      upsertError = await create(first, signer, new Date(Date.now() - limits.PENDING_DEPLOYMENT_TTL - 1_000)).catch(
        (error: unknown) => error
      )
      pending = await pendingCount()
    })

    it('should answer that the upload expired without creating it', () => {
      expect({ expired: upsertError instanceof PartialUploadExpiredError, pending }).toEqual({
        expired: true,
        pending: 0
      })
    })
  })

  describe('and an upload reaches its deadline before its batch is charged', () => {
    let reserveError: unknown
    let charges: unknown

    beforeEach(async () => {
      await create(first)
      await components.database.query(SQL`UPDATE pending_scenes SET created_at = now() - interval '2 days'`)
      reserveError = await manager
        .reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
        .catch((error: unknown) => error)
      const reserved = await components.database.query('SELECT reserved_bytes FROM pending_scenes')
      const rate = await components.database.query('SELECT bytes FROM partial_upload_rates')
      charges = { reserved: reserved.rows, rate: rate.rows }
    })

    it('should answer that the upload expired without charging its bytes or byte rate', () => {
      expect({ expired: reserveError instanceof PartialUploadExpiredError, charges }).toEqual({
        expired: true,
        charges: { reserved: [{ reserved_bytes: '0' }], rate: [] }
      })
    })
  })

  describe('and an upload reaches its deadline while its batch waits for the byte budget', () => {
    type LockClient = { query(sql: string): Promise<{ rowCount: number | null }>; release(): void }
    let lockClient: LockClient | undefined
    let reserveError: unknown
    let reserved: unknown
    let waitedOnBudget: boolean

    beforeEach(async () => {
      await create(first)
      lockClient = (await components.database.getPool().connect()) as unknown as LockClient
      await lockClient.query('BEGIN')
      await lockClient.query(`SELECT pg_advisory_xact_lock(hashtextextended('partial-upload-budget', 0))`)
      const reservation = manager
        .reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
        .catch((error: unknown) => error)
      waitedOnBudget = await waitForAdvisoryLocks(components.database, 'partial-upload-budget', 'waiting').then(
        () => true,
        () => false
      )
      const realNow = Date.now.bind(Date)
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + limits.PENDING_DEPLOYMENT_TTL + 1_000)
      await lockClient.query('COMMIT')
      lockClient.release()
      lockClient = undefined
      reserveError = await reservation
      reserved = (await components.database.query('SELECT reserved_bytes FROM pending_scenes')).rows
    })

    afterEach(async () => {
      if (lockClient) {
        await lockClient.query('ROLLBACK').catch(() => undefined)
        lockClient.release()
      }
    })

    it('should answer that the upload expired without reserving its bytes', () => {
      expect({ waitedOnBudget, expired: reserveError instanceof PartialUploadExpiredError, reserved }).toEqual({
        waitedOnBudget: true,
        expired: true,
        reserved: [{ reserved_bytes: '0' }]
      })
    })
  })

  describe('and two overlapping uploads reserve the same account budget concurrently', () => {
    let outcome: { fulfilled: number; rejections: unknown[] }
    let count: number
    let progress: unknown[]

    beforeEach(async () => {
      await create(first)
      await create(second)
      outcome = settle(
        await Promise.allSettled([
          manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400),
          manager.reserve(second.id, [{ hash: 'content-b', size: 400, stored: false, charged: true }], 1000n, 400)
        ])
      )
      count = await pendingCount()
      progress = [...(await repository.getProgress(first.id)), ...(await repository.getProgress(second.id))]
    })

    it('should admit only one reservation, rejecting the other with the account byte quota', () => {
      expect(outcome).toEqual({
        fulfilled: 1,
        rejections: [
          expect.objectContaining({ constructor: PartialUploadQuotaExceededError, quota: 'bytes_per_account' })
        ]
      })
    })

    it('should not replace either upload', () => {
      expect(count).toBe(2)
    })

    it('should not treat reserved bytes as stored files', () => {
      expect(progress).toEqual([])
    })
  })

  describe('and different accounts race the global budget', () => {
    let outcome: { fulfilled: number; rejections: unknown[] }

    beforeEach(async () => {
      await create(first)
      await create(second, '0xanother')
      outcome = settle(
        await Promise.allSettled([
          manager.reserve(first.id, [{ hash: 'content-a', size: 600, stored: false, charged: true }], 1000n, 600),
          manager.reserve(second.id, [{ hash: 'content-b', size: 600, stored: false, charged: true }], 1000n, 600)
        ])
      )
    })

    it('should never admit more than the global byte budget, rejecting the other with the server byte quota', () => {
      expect(outcome).toEqual({
        fulfilled: 1,
        rejections: [
          expect.objectContaining({ constructor: PartialUploadQuotaExceededError, quota: 'bytes_per_server' })
        ]
      })
    })
  })

  describe('and a retry reserves the same file again', () => {
    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
    })
    it('should charge storage once while charging both requests against the byte rate', async () => {
      const result = await components.database.query<{ reserved_bytes: string; bytes: string }>(
        'SELECT p.reserved_bytes, r.bytes FROM pending_scenes p JOIN partial_upload_rates r USING (deployer)'
      )
      expect(result.rows).toEqual([{ reserved_bytes: '400', bytes: '800' }])
    })
  })

  describe('and a batch alone exceeds the account byte budget', () => {
    let error: unknown
    let rateBytes: string

    beforeEach(async () => {
      await create(first)
      error = await manager
        .reserve(first.id, [{ hash: 'content-a', size: 700, stored: false, charged: true }], 1000n, 700)
        .catch((e) => e)
      const result = await components.database.query<{ bytes: string }>('SELECT bytes FROM partial_upload_rates')
      rateBytes = result.rows[0].bytes
    })

    it('should reject it as too large for the account budget without a retry hint', () => {
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

    it('should still charge the received bytes against the byte rate', () => {
      expect(rateBytes).toBe('700')
    })
  })

  describe("and an upload's own batches add up past the account byte budget", () => {
    let error: unknown

    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      error = await manager
        .reserve(first.id, [{ hash: 'content-b', size: 300, stored: false, charged: true }], 1000n, 300)
        .catch((e: unknown) => e)
    })

    it('should reject it as too large for the account budget', () => {
      expect({
        tooLarge: error instanceof PartialUploadTooLargeError,
        quota: (error as PartialUploadTooLargeError).quota
      }).toEqual({ tooLarge: true, quota: 'bytes_per_account' })
    })
  })

  describe('and the account already has its maximum of uploads', () => {
    let error: unknown

    beforeEach(async () => {
      await build({ maxPendingDeploymentsPerDeployer: 1 })
      await create(first, signer, new Date(Date.now() - 60_000))
      error = await create(second).catch((e: unknown) => e)
    })

    it('should reject with the upload-count quota, retrying when its oldest upload expires', () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'uploads_per_account',
        message:
          'Too many partial uploads in progress for this account: 1 of the 1 allowed. Complete an upload or wait for expired uploads to be cleaned up.',
        retryAfter: 240
      })
    })
  })

  describe('and the account is at its maximum of uploads with one awaiting cleanup', () => {
    describe('and no cleanup has run yet', () => {
      let error: unknown

      beforeEach(async () => {
        await build({ maxPendingDeploymentsPerDeployer: 1 })
        await create(first)
        // Expired uploads can't be created, so this one is aged past its lifetime after the fact.
        await components.database.query(
          SQL`UPDATE pending_scenes SET created_at = ${new Date(Date.now() - 400_000)} WHERE entity_id = ${first.id}`
        )
        error = await create(second).catch((e: unknown) => e)
      })

      it('should retry after one cleanup interval', () => {
        expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(120)
      })
    })

    describe('and the last cleanup finished 50 seconds ago', () => {
      let error: unknown

      beforeEach(async () => {
        await build({ maxPendingDeploymentsPerDeployer: 1 })
        await gc.deleteExpiredUploads()
        await create(first)
        // Expired uploads can't be created, so this one is aged past its lifetime after the fact.
        await components.database.query(
          SQL`UPDATE pending_scenes SET created_at = ${new Date(Date.now() - 400_000)} WHERE entity_id = ${first.id}`
        )
        const now = Date.now()
        jest.spyOn(Date, 'now').mockReturnValue(now + 50_000)
        error = await create(second, signer, new Date(now + 50_000)).catch((e: unknown) => e)
      })

      it('should retry when the next cleanup runs', () => {
        expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(70)
      })
    })
  })

  describe('and the lifetime and cleanup settings are not configured', () => {
    let defaults: { ttlMs: number; cleanupIntervalMs: number }

    beforeEach(async () => {
      const unconfigured = await loadUploadLimits({ getNumber: jest.fn(async () => undefined) })
      defaults = {
        ttlMs: unconfigured.pendingDeploymentTtlMs,
        cleanupIntervalMs: unconfigured.partialUploadCleanupIntervalMs
      }
    })

    it('should keep uploads for one hour and clean them up every five minutes', () => {
      expect(defaults).toEqual({ ttlMs: 60 * 60 * 1000, cleanupIntervalMs: 5 * 60 * 1000 })
    })
  })

  describe('and a batch exceeds the account byte quota', () => {
    let error: unknown

    beforeEach(async () => {
      await create({ ...first, id: 'idle' }, signer, new Date(Date.now() - 250_000))
      await create({ ...first, id: 'other' }, '0xother', new Date(Date.now() - 150_000))
      await create(first, signer, new Date(Date.now() - 100_000))
      await create(second)
      await manager.reserve('other', [{ hash: 'content-c', size: 50, stored: false, charged: true }], 1000n, 50)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      error = await manager
        .reserve(second.id, [{ hash: 'content-b', size: 300, stored: false, charged: true }], 1000n, 300)
        .catch((e: unknown) => e)
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

  describe('and a batch exceeds the server byte quota', () => {
    let error: unknown

    beforeEach(async () => {
      await create({ ...first, id: 'idle' }, '0xidle', new Date(Date.now() - 250_000))
      await create(first, '0xanother', new Date(Date.now() - 50_000))
      await create(second)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 500, stored: false, charged: true }], 1000n, 500)
      error = await manager
        .reserve(second.id, [{ hash: 'content-b', size: 550, stored: false, charged: true }], 1000n, 550)
        .catch((e: unknown) => e)
    })

    it("should reject with the server byte quota, retrying when the server's oldest charged upload expires", () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'bytes_per_server',
        message: 'This batch would stage 1.0 KiB on the server, above its limit of 1000 bytes. Retry later.',
        retryAfter: 250
      })
    })
  })

  describe('and a batch exceeds the per-minute byte rate', () => {
    let error: unknown

    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 100, stored: false, charged: true }], 1000n, 100)
      await components.database.query(
        SQL`UPDATE partial_upload_rates SET window_started = now() - interval '30 seconds'`
      )
      error = await manager
        .reserve(
          first.id,
          [{ hash: 'content-a', size: 100, stored: false, charged: true }],
          1000n,
          DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
        )
        .catch((e: unknown) => e)
    })

    it("should reject with the byte-rate quota, retrying when the account's minute window resets", () => {
      expect({
        quota: (error as PartialUploadQuotaExceededError).quota,
        message: (error as Error).message,
        retryAfter: (error as PartialUploadQuotaExceededError).retryAfterSeconds
      }).toEqual({
        quota: 'bytes_per_minute',
        message:
          'This account sent 350.0 MiB of partial uploads this minute, above the limit of 350.0 MiB per minute. Retry in 30 s.',
        retryAfter: 30
      })
    })
  })

  describe('and a batch arrives after the minute window of an account at its byte rate elapsed', () => {
    let error: unknown
    let rate: { bytes: string; reset: boolean }[]

    beforeEach(async () => {
      await create(first)
      await manager.reserve(
        first.id,
        [{ hash: 'content-a', size: 100, stored: false, charged: true }],
        1000n,
        DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
      )
      await components.database.query(
        SQL`UPDATE partial_upload_rates SET window_started = now() - interval '61 seconds'`
      )
      error = await manager
        .reserve(first.id, [{ hash: 'content-a', size: 100, stored: false, charged: true }], 1000n, 100)
        .then(() => undefined)
        .catch((e: unknown) => e)
      const result = await components.database.query<{ bytes: string; reset: boolean }>(
        `SELECT bytes, window_started > now() - interval '10 seconds' AS reset FROM partial_upload_rates`
      )
      rate = result.rows
    })

    it('should admit it', () => {
      expect(error).toBeUndefined()
    })

    it('should start a new window charged with only the incoming bytes', () => {
      expect(rate).toEqual([{ bytes: '100', reset: true }])
    })
  })

  describe('and stale and fresh byte-rate windows are pruned', () => {
    let deployers: string[]

    beforeEach(async () => {
      await components.database.query(`
        INSERT INTO partial_upload_rates (deployer, window_started, bytes) VALUES
          ('0xstale', now() - interval '61 seconds', 10),
          ('0xfresh', now() - interval '30 seconds', 10)`)
      await repository.pruneByteRates()
      const result = await components.database.query<{ deployer: string }>('SELECT deployer FROM partial_upload_rates')
      deployers = result.rows.map((row) => row.deployer)
    })

    it('should delete only the windows older than a minute', () => {
      expect(deployers).toEqual(['0xfresh'])
    })
  })

  describe('and completion receipts older and newer than the cutoff are pruned', () => {
    let entityIds: string[]

    beforeEach(async () => {
      await components.database.query(`
        INSERT INTO completed_scene_uploads (entity_id, deployer, world_name, parcels, completed_at) VALUES
          ('old', '0xaccount', 'test.dcl.eth', '{0,0}', now() - interval '2 hours'),
          ('recent', '0xaccount', 'test.dcl.eth', '{0,0}', now())`)
      await repository.pruneCompleted(new Date(Date.now() - 60 * 60 * 1000))
      const result = await components.database.query<{ entity_id: string }>(
        'SELECT entity_id FROM completed_scene_uploads'
      )
      entityIds = result.rows.map((row) => row.entity_id)
    })

    it('should delete only the receipts completed before the cutoff', () => {
      expect(entityIds).toEqual(['recent'])
    })
  })

  describe('and one upload was created exactly one lifetime before the cutoff instant and another just after', () => {
    let cutoff: Date
    let listed: string[]
    let counts: { live: number; expired: number }
    let charged: { bytes: number; expired: number }
    let referenced: Set<string>
    let atCutoffLive: unknown
    let remaining: string[]

    beforeEach(async () => {
      cutoff = new Date('2026-01-01T00:00:00.000Z')
      const justAfter = new Date(cutoff.getTime() + 1)
      const uploads: { entityId: string; createdAt: Date; size: number }[] = [
        { entityId: 'at-cutoff', createdAt: cutoff, size: 100 },
        { entityId: 'after-cutoff', createdAt: justAfter, size: 50 }
      ]
      for (const { entityId, createdAt, size } of uploads) {
        await components.database.query(SQL`
          INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at)
          VALUES (${entityId}, 'test.dcl.eth', '{0,0}', ${JSON.stringify({ ...first, id: entityId })}::jsonb,
            ${signer}, ${createdAt})`)
        await components.database.query(SQL`
          INSERT INTO pending_scene_files (entity_id, hash, size, stored, charged)
          VALUES (${entityId}, ${entityId + '-file'}, ${size}, true, true)`)
      }
      listed = (await repository.listExpired(cutoff, undefined, 10)).map((upload) => upload.entityId)
      counts = await repository.countUploads(cutoff)
      charged = await repository.getChargedBytes(cutoff)
      referenced = await repository.getReferencedContentKeys(cutoff, ['at-cutoff', 'after-cutoff'])
      atCutoffLive = await repository.getCreatedSince('at-cutoff', cutoff)
      await repository.releaseExpired('at-cutoff', cutoff)
      await repository.releaseExpired('after-cutoff', cutoff)
      const result = await components.database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
      remaining = result.rows.map((row) => row.entity_id)
    })

    it('should list only the upload created at the cutoff as expired', () => {
      expect(listed).toEqual(['at-cutoff'])
    })

    it('should count the upload created at the cutoff as expired and the other as live', () => {
      expect(counts).toEqual({ live: 1, expired: 1 })
    })

    it('should report only the charged bytes of the upload created at the cutoff as expired', () => {
      expect(charged).toEqual({ bytes: 150, expired: 100 })
    })

    it('should keep only the upload created after the cutoff referencing its content', () => {
      expect(referenced).toEqual(new Set(['after-cutoff']))
    })

    it('should not return the upload created at the cutoff as live', () => {
      expect(atCutoffLive).toBeUndefined()
    })

    it('should release only the upload created at the cutoff', () => {
      expect(remaining).toEqual(['after-cutoff'])
    })
  })

  describe('and pending uploads are deleted by entity id', () => {
    let entityIds: string[]

    beforeEach(async () => {
      const published = await components.worldCreator.createWorldWithScene()
      await create(first)
      await create({ ...first, id: published.entityId })
      await repository.deleteByEntityId(first.id)
      await repository.deleteByEntityId(published.entityId)
      const result = await components.database.query<{ entity_id: string }>('SELECT entity_id FROM pending_scenes')
      entityIds = result.rows.map((row) => row.entity_id)
    })

    it('should keep the upload whose entity was never published and delete the published one', () => {
      expect(entityIds).toEqual([first.id])
    })
  })

  describe('and a batch alone exceeds the per-minute byte rate', () => {
    let error: unknown
    let rateBytes: string

    beforeEach(async () => {
      await create(first)
      error = await manager
        .reserve(
          first.id,
          [{ hash: 'content-a', size: 100, stored: false, charged: true }],
          1000n,
          DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 1
        )
        .catch((e: unknown) => e)
      const result = await components.database.query<{ bytes: string }>('SELECT bytes FROM partial_upload_rates')
      rateBytes = result.rows[0].bytes
    })

    it('should reject it as too large for the byte rate without a retry hint', () => {
      expect({
        tooLarge: error instanceof PartialUploadTooLargeError,
        quota: (error as PartialUploadTooLargeError).quota,
        message: (error as Error).message
      }).toEqual({
        tooLarge: true,
        quota: 'bytes_per_minute',
        message:
          'This batch is 350.0 MiB, above the partial upload limit of 350.0 MiB per minute. Send smaller batches.'
      })
    })

    it('should still charge the received bytes against the byte rate', () => {
      expect(rateBytes).toBe(String(DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 1))
    })
  })

  describe('and the first batch of a new upload is rejected and discarded', () => {
    beforeEach(async () => {
      await create(first)
      await manager
        .reserve(first.id, [{ hash: 'content-a', size: 700, stored: false, charged: true }], 1000n, 700)
        .catch(() => undefined)
      await repository.discardUnadmitted(first.id)
    })

    it('should free the upload slot', async () => {
      expect(await pendingCount()).toBe(0)
    })
  })

  describe('and an admitted upload is discarded as unadmitted', () => {
    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      await repository.discardUnadmitted(first.id)
    })

    it('should keep the upload and its reservation', async () => {
      expect(await pendingCount()).toBe(1)
    })
  })

  describe('and most of an upload is already in storage', () => {
    let reserveError: unknown
    let accounting: unknown

    beforeEach(async () => {
      await create(first)
      reserveError = await manager
        .reserve(
          first.id,
          [
            { hash: 'content-a', size: 500, stored: true, charged: false },
            { hash: 'content-b', size: 200, stored: false, charged: true }
          ],
          1000n,
          200
        )
        .catch((error: unknown) => error)
      const reserved = await components.database.query('SELECT reserved_bytes FROM pending_scenes')
      const files = await components.database.query('SELECT hash, charged FROM pending_scene_files ORDER BY hash')
      accounting = { reserved: reserved.rows, files: files.rows }
    })

    it('should admit it charging only the bytes it stores, even though the whole scene exceeds the account budget', () => {
      expect({ reserveError, accounting }).toEqual({
        reserveError: undefined,
        accounting: {
          reserved: [{ reserved_bytes: '200' }],
          files: [
            { hash: 'content-a', charged: false },
            { hash: 'content-b', charged: true }
          ]
        }
      })
    })
  })

  describe('and the content already in storage makes the scene exceed its size limit', () => {
    let reserveError: unknown

    beforeEach(async () => {
      await create(first)
      reserveError = await manager
        .reserve(
          first.id,
          [
            { hash: 'content-a', size: 900, stored: true, charged: false },
            { hash: 'content-b', size: 200, stored: false, charged: true }
          ],
          1000n,
          200
        )
        .catch((error: unknown) => error)
    })

    it('should reject the scene as too big', () => {
      expect(reserveError).toEqual(new InvalidRequestError('Deployment failed: The deployment is too big.'))
    })
  })

  describe('and a file already in storage is marked missing and re-uploaded', () => {
    let accounting: unknown

    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: true, charged: false }], 1000n, 0)
      await manager.markMissing(first.id, ['content-a'])
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      const reserved = await components.database.query('SELECT reserved_bytes FROM pending_scenes')
      const files = await components.database.query('SELECT hash, stored, charged FROM pending_scene_files')
      accounting = { reserved: reserved.rows, files: files.rows }
    })

    it('should charge the re-uploaded file', () => {
      expect(accounting).toEqual({
        reserved: [{ reserved_bytes: '400' }],
        files: [{ hash: 'content-a', stored: false, charged: true }]
      })
    })
  })

  describe('and a charged file is later reported as already in storage', () => {
    let reserved: unknown

    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: true, charged: false }], 1000n, 0)
      reserved = (await components.database.query('SELECT reserved_bytes FROM pending_scenes')).rows
    })

    it('should keep it charged', () => {
      expect(reserved).toEqual([{ reserved_bytes: '400' }])
    })
  })

  describe('and cleanup reports the staged bytes of an upload reusing stored content', () => {
    let observe: jest.SpyInstance
    let gauges: unknown[]

    beforeEach(async () => {
      await create(first)
      await manager.reserve(
        first.id,
        [
          { hash: 'content-a', size: 500, stored: true, charged: false },
          { hash: 'content-b', size: 100, stored: false, charged: true }
        ],
        1000n,
        100
      )
      observe = jest.spyOn(components.metrics, 'observe')
      // The upload is still live when the sweep picks expired uploads and has expired when bytes are summed.
      const now = Date.now()
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(now)
        .mockReturnValue(now + limits.PENDING_DEPLOYMENT_TTL + 1_000)
      await gc.deleteExpiredUploads()
      gauges = observe.mock.calls.filter(
        ([name]) => name === 'partial_upload_reserved_bytes' || name === 'partial_upload_cleanup_backlog_bytes'
      )
    })

    it('should count only charged bytes as reserved and as cleanup backlog', () => {
      expect(gauges).toEqual([
        ['partial_upload_reserved_bytes', {}, 100],
        ['partial_upload_cleanup_backlog_bytes', {}, 100]
      ])
    })
  })

  describe('and an expired upload still occupies storage', () => {
    function reserveSecond(): Promise<unknown> {
      return manager
        .reserve(second.id, [{ hash: 'content-b', size: 400, stored: false, charged: true }], 1000n, 400)
        .then(() => undefined)
        .catch((error: unknown) => error)
    }

    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false, charged: true }], 1000n, 400)
      await components.storage.storeStream('content-a', bufferToStream(Buffer.alloc(400)))
      await components.database.query(SQL`UPDATE pending_scenes SET created_at = now() - interval '2 days'`)
      await create(second)
    })

    describe('and the account reserves another batch before cleanup runs', () => {
      let reserveError: unknown

      beforeEach(async () => {
        reserveError = await reserveSecond()
      })

      it('should keep its bytes charged against the account budget', () => {
        expect(reserveError).toEqual(
          expect.objectContaining({ message: expect.stringContaining('above its limit of 600 bytes') })
        )
      })
    })

    describe('and cleanup succeeds', () => {
      let reserveError: unknown
      let stored: boolean

      beforeEach(async () => {
        await gc.deleteExpiredUploads()
        reserveError = await reserveSecond()
        stored = await components.storage.exist('content-a')
      })

      it('should release its bytes for the next batch', () => {
        expect(reserveError).toBeUndefined()
      })

      it('should delete its content from storage', () => {
        expect(stored).toBe(false)
      })
    })

    describe('and physical deletion fails', () => {
      let cleanupResult: unknown
      let reserveError: unknown

      beforeEach(async () => {
        jest.spyOn(components.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'))
        cleanupResult = await gc.deleteExpiredUploads()
        reserveError = await reserveSecond()
      })

      it('should report the failure', () => {
        expect(cleanupResult).toEqual({ outcome: 'error', removed: 0, failed: 1 })
      })

      it('should preserve the reservation for a later cleanup retry', () => {
        expect(reserveError).toEqual(
          expect.objectContaining({ message: expect.stringContaining('above its limit of 600 bytes') })
        )
      })
    })

    describe('and a live upload references the same hash', () => {
      let stored: boolean
      let count: number

      beforeEach(async () => {
        await components.database.query(
          SQL`UPDATE pending_scenes SET entity = ${first}::jsonb WHERE entity_id = ${second.id}`
        )
        await gc.deleteExpiredUploads()
        stored = await components.storage.exist('content-a')
        count = await pendingCount()
      })

      it('should release expired accounting without deleting content retained by the live upload', () => {
        expect({ stored, count }).toEqual({ stored: true, count: 1 })
      })
    })
  })

  describe('and the oldest of two expired uploads fails to be deleted from storage', () => {
    let result: unknown
    let remaining: unknown[]

    beforeEach(async () => {
      await create(first)
      await create(second)
      // Same instant up to the microsecond, so only the entity id orders them.
      await components.database.query(
        SQL`UPDATE pending_scenes SET created_at = now() - interval '2 days' + interval '1 microsecond'`
      )
      jest.spyOn(components.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'))
      result = await gc.deleteExpiredUploads()
      remaining = (await components.database.query('SELECT entity_id FROM pending_scenes')).rows
    })

    it('should still reclaim the later upload and keep the failed one for a retry', () => {
      expect({ result, remaining }).toEqual({
        result: { outcome: 'error', removed: 1, failed: 1 },
        remaining: [{ entity_id: first.id }]
      })
    })
  })

  describe('and more expired uploads than one cleanup page exist, the oldest failing', () => {
    let result: unknown
    let remaining: unknown[]

    beforeEach(async () => {
      // Microseconds apart within one millisecond, so the keyset cursor must keep them.
      await components.database.query(SQL`
        INSERT INTO pending_scenes (entity_id, world_name, parcels, entity, deployer, created_at)
        SELECT 'bulk-' || lpad(i::text, 3, '0'), 'test.dcl.eth', ARRAY['0,0'], '{}'::jsonb, ${signer},
          date_trunc('milliseconds', now() - interval '2 days') + (i + 1) * interval '1 microsecond'
        FROM generate_series(0, ${CLEANUP_PAGE_SIZE}) AS i`)
      jest.spyOn(components.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'))
      result = await gc.deleteExpiredUploads()
      remaining = (await components.database.query('SELECT entity_id FROM pending_scenes')).rows
    })

    it('should visit every page once and keep only the failed upload', () => {
      expect({ result, remaining }).toEqual({
        result: { outcome: 'error', removed: CLEANUP_PAGE_SIZE, failed: 1 },
        remaining: [{ entity_id: 'bulk-000' }]
      })
    })
  })

  describe('and a storage mutation holds the shared content lock', () => {
    let releaseUpload: () => void
    let upload: Promise<void>
    let deletion: Promise<void>
    let deleting: boolean
    let deletingWhileHeld: boolean
    let uploadActive: boolean
    let overlapped: boolean

    beforeEach(async () => {
      deleting = false
      uploadActive = false
      overlapped = false
      let acquired: () => void
      const started = new Promise<void>((resolve) => {
        acquired = resolve
      })
      upload = components.contentLocks.withRead(async () => {
        uploadActive = true
        acquired()
        await new Promise<void>((resolve) => {
          releaseUpload = resolve
        })
        uploadActive = false
      })
      await started
      deletion = components.contentLocks.withWrite(async () => {
        deleting = true
        overlapped = uploadActive
      })
      // Gives the writer time for several lock attempts while the upload holds the gate.
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      deletingWhileHeld = deleting
      releaseUpload()
      await Promise.all([upload, deletion])
    })

    afterEach(async () => {
      releaseUpload()
      await Promise.all([upload, deletion])
    })

    it('should not run GC while the mutation holds the lock', () => {
      expect(deletingWhileHeld).toBe(false)
    })

    it('should run GC once the mutation settles, without overlapping it', () => {
      expect({ deleting, overlapped }).toEqual({ deleting: true, overlapped: false })
    })
  })
})
