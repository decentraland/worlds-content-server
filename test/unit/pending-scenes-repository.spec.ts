import { createPendingScenesRepository } from '../../src/adapters/pending-scenes-repository'
import { PublicationRecord } from '../../src/adapters/pending-scenes-repository/types'

type Statement = { text: string; values: unknown[] }

describe('when recording the publication of an entity', () => {
  let query: jest.Mock
  let publication: PublicationRecord
  let deletedRows: { live: boolean }[]
  let result: { consumed: boolean; live: boolean }
  let pendingDeletion: Statement

  beforeEach(() => {
    deletedRows = []
    query = jest.fn(async (statement: Statement) =>
      statement.text.startsWith('DELETE FROM pending_scenes') ? { rows: deletedRows } : { rows: [] }
    )
    publication = {
      entityId: 'entity-id',
      deployer: '0xdeployer',
      worldName: 'world.dcl.eth',
      parcels: ['0,0'],
      publishedAt: new Date(0)
    }
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  async function record(): Promise<void> {
    const repository = await createPendingScenesRepository({ database: {} } as never)
    result = await repository.recordPublication(query, publication)
    pendingDeletion = query.mock.calls
      .map(([statement]) => statement as Statement)
      .find((statement) => statement.text.startsWith('DELETE FROM pending_scenes'))!
  }

  describe('and it finalizes a partial upload', () => {
    beforeEach(() => {
      publication.completesPartialUpload = { ttlMs: 3_600_000 }
    })

    describe('and the deleted upload was still live by the database clock', () => {
      beforeEach(async () => {
        deletedRows = [{ live: true }]
        await record()
      })

      it('should judge its liveness on the database clock with the lifetime in seconds', () => {
        expect(pendingDeletion).toEqual(
          expect.objectContaining({
            text: "DELETE FROM pending_scenes WHERE entity_id = $1 RETURNING created_at > (now() - $2::float8 * interval '1 second') AS live",
            values: ['entity-id', 3600]
          })
        )
      })

      it('should report the upload as consumed while live', () => {
        expect(result).toEqual({ consumed: true, live: true })
      })
    })

    describe('and the deleted upload had expired by the database clock', () => {
      beforeEach(async () => {
        deletedRows = [{ live: false }]
        await record()
      })

      it('should report the upload as consumed but not live', () => {
        expect(result).toEqual({ consumed: true, live: false })
      })
    })

    describe('and no upload was left to delete', () => {
      beforeEach(async () => {
        await record()
      })

      it('should report nothing consumed', () => {
        expect(result).toEqual({ consumed: false, live: false })
      })
    })
  })

  describe('and it does not finalize a partial upload', () => {
    beforeEach(async () => {
      deletedRows = [{ live: true }]
      await record()
    })

    it('should delete the pending upload without judging its expiry', () => {
      expect(pendingDeletion.text).toBe('DELETE FROM pending_scenes WHERE entity_id = $1 RETURNING true AS live')
    })
  })
})
