import { createPendingScenesManager } from '../../src/adapters/pending-scenes-manager'
import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES } from '../../src/logic/multipart'

function build(limits: Record<string, number>) {
  return createPendingScenesManager({
    config: { getNumber: jest.fn(async (key: string) => limits[key]) },
    database: {},
    logs: { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
    metrics: { observe: jest.fn() },
    storage: {},
    contentLocks: {}
  } as any)
}

describe('when creating the pending scenes manager with partial upload limits', () => {
  let limits: Record<string, number>
  let result: unknown

  beforeEach(() => {
    limits = {
      MAX_PENDING_BYTES_PER_DEPLOYER: 1000,
      MAX_PENDING_BYTES: 1000,
      MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES
    }
  })

  describe('and the limits fit one maximum-size request and the account budget', () => {
    beforeEach(async () => {
      result = await build(limits).catch((error: unknown) => error)
    })

    it('should create the manager', () => {
      expect(result).not.toBeInstanceOf(Error)
    })
  })

  describe('and the per-minute byte rate is below one maximum-size request', () => {
    beforeEach(async () => {
      limits.MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1
      result = await build(limits).catch((error: unknown) => error)
    })

    it('should fail to start naming the per-minute limit', () => {
      expect((result as Error).message).toBe(
        `MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
      )
    })
  })

  describe('and the server budget is below the account budget', () => {
    beforeEach(async () => {
      limits.MAX_PENDING_BYTES = 999
      result = await build(limits).catch((error: unknown) => error)
    })

    it('should fail to start naming both budgets', () => {
      expect((result as Error).message).toBe(
        'MAX_PENDING_BYTES (999) must be at least MAX_PENDING_BYTES_PER_DEPLOYER (1000).'
      )
    })
  })
})
