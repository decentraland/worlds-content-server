import SQL from 'sql-template-strings'
import { Entity, EntityType } from '@dcl/schemas'
import { bufferToStream } from '@dcl/catalyst-storage'
import { test } from '../components'
import { cleanup } from '../utils'
import { createPendingScenesManager } from '../../src/adapters/pending-scenes-manager'
import { IPendingScenesManager } from '../../src/adapters/pending-scenes-manager/types'

test('when accounting for independent partial uploads', ({ components }) => {
  let manager: IPendingScenesManager
  let first: Entity
  let second: Entity
  let signer: string
  let limits: Record<string, number>

  async function create(entity: Entity, deployer = signer): Promise<void> {
    await manager.upsert(
      { entityId: entity.id, entity, deployer, worldName: 'test.dcl.eth', parcels: ['0,0'] },
      { maxPendingPerDeployer: 10 }
    )
  }

  async function pendingCount(): Promise<number> {
    const result = await components.database.query<{ count: string }>('SELECT COUNT(*) AS count FROM pending_scenes')
    return Number(result.rows[0].count)
  }

  beforeEach(async () => {
    limits = { MAX_PENDING_BYTES_PER_DEPLOYER: 600, MAX_PENDING_BYTES: 1000, MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE: 5000 }
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

  describe('and a batch is rejected by the byte budget', () => {
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

    it('should still charge the received bytes against the byte rate', () => {
      expect({ message: (error as Error).message, rateBytes }).toEqual({
        message: 'Partial upload storage budget exceeded. Complete uploads or wait for cleanup.',
        rateBytes: '700'
      })
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
      ).rejects.toThrow('storage budget exceeded')
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
        ).rejects.toThrow('storage budget exceeded')
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
