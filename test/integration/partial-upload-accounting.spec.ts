import SQL from 'sql-template-strings'
import { Entity, EntityType } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage'
import { test } from '../components'
import { cleanup } from '../utils'
import {
  createPendingScenesManager,
  PartialUploadExpiredError,
  PartialUploadQuotaExceededError,
  PartialUploadTooLargeError
} from '../../src/adapters/pending-scenes-manager'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES } from '../../src/logic/multipart'
import { IPendingScenesManager } from '../../src/adapters/pending-scenes-manager/types'

test('when accounting for independent partial uploads', ({ components }) => {
  let manager: IPendingScenesManager
  let first: Entity
  let second: Entity
  let signer: string
  let limits: Record<string, number>

  async function create(
    entity: Entity,
    deployer = signer,
    admittedAt = new Date(),
    resumes = false,
    maxPendingPerDeployer = 10
  ): Promise<void> {
    await manager.upsert(
      { entityId: entity.id, entity, deployer, worldName: 'test.dcl.eth', parcels: ['0,0'], admittedAt, resumes },
      { maxPendingPerDeployer }
    )
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
    manager = await createPendingScenesManager({
      config: { ...components.config, getNumber: jest.fn(async (key: string) => limits[key]) },
      database: components.database,
      logs: components.logs,
      metrics: components.metrics,
      storage: components.storage,
      contentLocks: components.contentLocks
    })
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
        .reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
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

    beforeEach(async () => {
      await create(first)
      lockClient = (await components.database.getPool().connect()) as unknown as LockClient
      await lockClient.query('BEGIN')
      await lockClient.query(`SELECT pg_advisory_xact_lock(hashtextextended('partial-upload-budget', 0))`)
      const reservation = manager
        .reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
        .catch((error: unknown) => error)
      let waiting = false
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const locks = await lockClient.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        waiting = (locks.rowCount ?? 0) > 0
        if (!waiting) await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
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
      expect({ expired: reserveError instanceof PartialUploadExpiredError, reserved }).toEqual({
        expired: true,
        reserved: [{ reserved_bytes: '0' }]
      })
    })
  })

  describe('and two overlapping uploads reserve the same account budget concurrently', () => {
    let results: PromiseSettledResult<void>[]
    beforeEach(async () => {
      await create(first)
      await create(second)
      results = await Promise.allSettled([
        manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400),
        manager.reserve(second.id, [{ hash: 'content-b', size: 400, stored: false }], 1000n, 400)
      ])
    })
    it('should admit only one reservation without replacing either upload', async () => {
      expect({
        fulfilled: results.filter((result) => result.status === 'fulfilled').length,
        count: await pendingCount()
      }).toEqual({ fulfilled: 1, count: 2 })
    })
    it('should not treat reserved bytes as stored files', async () => {
      expect([...(await manager.getProgress(first.id)), ...(await manager.getProgress(second.id))]).toEqual([])
    })
  })

  describe('and different accounts race the global budget', () => {
    let results: PromiseSettledResult<void>[]
    beforeEach(async () => {
      await create(first)
      await create(second, '0xanother')
      results = await Promise.allSettled([
        manager.reserve(first.id, [{ hash: 'content-a', size: 600, stored: false }], 1000n, 600),
        manager.reserve(second.id, [{ hash: 'content-b', size: 600, stored: false }], 1000n, 600)
      ])
    })
    it('should never admit more than the global byte budget', () => {
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    })
  })

  describe('and a retry reserves the same file again', () => {
    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
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
        .reserve(first.id, [{ hash: 'content-a', size: 700, stored: false }], 1000n, 700)
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
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
      error = await manager
        .reserve(first.id, [{ hash: 'content-b', size: 300, stored: false }], 1000n, 300)
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
      await create(first, signer, new Date(Date.now() - 60_000))
      error = await create(second, signer, new Date(), false, 1).catch((e: unknown) => e)
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
        await create(first)
        // Expired uploads can't be created, so this one is aged past its lifetime after the fact.
        await components.database.query(
          SQL`UPDATE pending_scenes SET created_at = ${new Date(Date.now() - 400_000)} WHERE entity_id = ${first.id}`
        )
        error = await create(second, signer, new Date(), false, 1).catch((e: unknown) => e)
      })

      it('should retry after one cleanup interval', () => {
        expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(120)
      })
    })

    describe('and the last cleanup finished 50 seconds ago', () => {
      let error: unknown

      beforeEach(async () => {
        await manager.deleteExpired()
        await create(first)
        // Expired uploads can't be created, so this one is aged past its lifetime after the fact.
        await components.database.query(
          SQL`UPDATE pending_scenes SET created_at = ${new Date(Date.now() - 400_000)} WHERE entity_id = ${first.id}`
        )
        const now = Date.now()
        jest.spyOn(Date, 'now').mockReturnValue(now + 50_000)
        error = await create(second, signer, new Date(now + 50_000), false, 1).catch((e: unknown) => e)
      })

      it('should retry when the next cleanup runs', () => {
        expect((error as PartialUploadQuotaExceededError).retryAfterSeconds).toBe(70)
      })
    })
  })

  describe('and the lifetime and cleanup settings are not configured', () => {
    let defaults: { ttlMs: number; cleanupIntervalMs: number }

    beforeEach(async () => {
      const unconfigured = await createPendingScenesManager({
        config: { ...components.config, getNumber: jest.fn(async () => undefined) },
        database: components.database,
        logs: components.logs,
        metrics: components.metrics,
        storage: components.storage,
        contentLocks: components.contentLocks
      })
      defaults = { ttlMs: unconfigured.ttlMs, cleanupIntervalMs: unconfigured.cleanupIntervalMs }
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
      await manager.reserve('other', [{ hash: 'content-c', size: 50, stored: false }], 1000n, 50)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
      error = await manager
        .reserve(second.id, [{ hash: 'content-b', size: 300, stored: false }], 1000n, 300)
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
      await manager.reserve(first.id, [{ hash: 'content-a', size: 500, stored: false }], 1000n, 500)
      error = await manager
        .reserve(second.id, [{ hash: 'content-b', size: 550, stored: false }], 1000n, 550)
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
      await manager.reserve(first.id, [{ hash: 'content-a', size: 100, stored: false }], 1000n, 100)
      await components.database.query(
        SQL`UPDATE partial_upload_rates SET window_started = now() - interval '30 seconds'`
      )
      error = await manager
        .reserve(first.id, [{ hash: 'content-a', size: 100, stored: false }], 1000n, DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES)
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

  describe('and a batch alone exceeds the per-minute byte rate', () => {
    let error: unknown
    let rateBytes: string

    beforeEach(async () => {
      await create(first)
      error = await manager
        .reserve(
          first.id,
          [{ hash: 'content-a', size: 100, stored: false }],
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
        .reserve(first.id, [{ hash: 'content-a', size: 700, stored: false }], 1000n, 700)
        .catch(() => undefined)
      await manager.discardUnadmitted(first.id)
    })

    it('should free the upload slot', async () => {
      expect(await pendingCount()).toBe(0)
    })
  })

  describe('and an admitted upload is discarded as unadmitted', () => {
    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
      await manager.discardUnadmitted(first.id)
    })

    it('should keep the upload and its reservation', async () => {
      expect(await pendingCount()).toBe(1)
    })
  })

  describe('and an expired upload still occupies storage', () => {
    beforeEach(async () => {
      await create(first)
      await manager.reserve(first.id, [{ hash: 'content-a', size: 400, stored: false }], 1000n, 400)
      await components.storage.storeStream('content-a', bufferToStream(Buffer.alloc(400)))
      await components.database.query(SQL`UPDATE pending_scenes SET created_at = now() - interval '2 days'`)
      await create(second)
    })

    it('should keep its bytes charged until cleanup succeeds', async () => {
      await expect(
        manager.reserve(second.id, [{ hash: 'content-b', size: 400, stored: false }], 1000n, 400)
      ).rejects.toThrow('above its limit of 600 bytes')
      await manager.deleteExpired()
      await expect(
        manager.reserve(second.id, [{ hash: 'content-b', size: 400, stored: false }], 1000n, 400)
      ).resolves.toBeUndefined()
      expect(await components.storage.exist('content-a')).toBe(false)
    })

    describe('and physical deletion fails', () => {
      beforeEach(() => {
        jest.spyOn(components.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'))
      })
      it('should preserve the reservation for a later cleanup retry', async () => {
        await expect(manager.deleteExpired()).rejects.toThrow('storage unavailable')
        await expect(
          manager.reserve(second.id, [{ hash: 'content-b', size: 400, stored: false }], 1000n, 400)
        ).rejects.toThrow('above its limit of 600 bytes')
      })
    })

    describe('and a live upload references the same hash', () => {
      beforeEach(async () => {
        await components.database.query(
          SQL`UPDATE pending_scenes SET entity = ${first}::jsonb WHERE entity_id = ${second.id}`
        )
      })
      it('should release expired accounting without deleting content retained by the live upload', async () => {
        await manager.deleteExpired()
        expect({ stored: await components.storage.exist('content-a'), count: await pendingCount() }).toEqual({
          stored: true,
          count: 1
        })
      })
    })
  })

  describe('and a storage mutation holds the shared content lock', () => {
    let releaseUpload: () => void
    let upload: Promise<void>
    let deletion: Promise<void>
    let deleting: boolean
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
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
    })

    afterEach(async () => {
      releaseUpload()
      await Promise.all([upload, deletion])
    })

    it('should exclude GC until the mutation settles', async () => {
      expect(deleting).toBe(false)
      releaseUpload()
      await Promise.all([upload, deletion])
      expect({ deleting, overlapped }).toEqual({ deleting: true, overlapped: false })
    })
  })
})
