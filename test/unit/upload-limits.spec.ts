import { DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES, loadUploadLimits, UploadLimits } from '../../src/logic/upload-limits'

const MiB = 1024 * 1024

describe('when loading the upload limits', () => {
  let settings: Record<string, number | undefined>
  let result: UploadLimits | Error

  function load(): Promise<UploadLimits | Error> {
    return loadUploadLimits({ getNumber: jest.fn(async (key: string) => settings[key]) }).catch((error: Error) => error)
  }

  beforeEach(() => {
    settings = {}
  })

  describe('and nothing is configured', () => {
    beforeEach(async () => {
      result = await load()
    })

    it('should use the defaults', () => {
      expect(result).toEqual({
        maxConcurrentUploadsPerSource: 4,
        maxInFlightUploadBytesPerSource: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES,
        maxSceneSizeInBytes: 500n * BigInt(MiB),
        maxPendingBytesPerDeployer: 1024n ** 3n,
        maxPendingBytes: 50n * 1024n ** 3n,
        maxPartialUploadBytesPerMinute: 512 * MiB,
        pendingDeploymentTtlMs: 60 * 60 * 1000,
        partialUploadCleanupIntervalMs: 5 * 60 * 1000,
        completedUploadTtlMs: 24 * 60 * 60 * 1000,
        maxPendingDeploymentsPerDeployer: 10
      })
    })
  })

  describe('and every setting is configured', () => {
    beforeEach(async () => {
      settings = {
        MAX_CONCURRENT_UPLOADS_PER_SOURCE: 2,
        MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 1,
        MAX_SCENE_SIZE: 2,
        MAX_PENDING_BYTES_PER_DEPLOYER: 3 * MiB,
        MAX_PENDING_BYTES: 4 * MiB,
        MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 2,
        PENDING_DEPLOYMENT_TTL: 1_000,
        PARTIAL_UPLOAD_CLEANUP_INTERVAL_MS: 2_000,
        COMPLETED_UPLOAD_TTL: 3_000,
        MAX_PENDING_DEPLOYMENTS_PER_DEPLOYER: 5
      }
      result = await load()
    })

    it('should return the configured values', () => {
      expect(result).toEqual({
        maxConcurrentUploadsPerSource: 2,
        maxInFlightUploadBytesPerSource: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 1,
        maxSceneSizeInBytes: 2n * BigInt(MiB),
        maxPendingBytesPerDeployer: 3n * BigInt(MiB),
        maxPendingBytes: 4n * BigInt(MiB),
        maxPartialUploadBytesPerMinute: DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES + 2,
        pendingDeploymentTtlMs: 1_000,
        partialUploadCleanupIntervalMs: 2_000,
        completedUploadTtlMs: 3_000,
        maxPendingDeploymentsPerDeployer: 5
      })
    })
  })

  describe('and the per-source byte share cannot fit one maximum-size upload', () => {
    beforeEach(async () => {
      settings.MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1
      result = await load()
    })

    it('should fail naming the per-source byte share', () => {
      expect((result as Error).message).toBe(
        `MAX_IN_FLIGHT_UPLOAD_BYTES_PER_SOURCE (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
      )
    })
  })

  describe.each([0, -1, 1.5, NaN])('and MAX_SCENE_SIZE is %s', (value) => {
    beforeEach(async () => {
      settings.MAX_SCENE_SIZE = value
      result = await load()
    })

    it('should fail naming MAX_SCENE_SIZE', () => {
      expect((result as Error).message).toBe(`MAX_SCENE_SIZE must be a positive safe integer, got ${value}`)
    })
  })

  describe('and the scene size cap does not fit the per-deployer staging budget', () => {
    beforeEach(async () => {
      settings.MAX_SCENE_SIZE = 2
      settings.MAX_PENDING_BYTES_PER_DEPLOYER = 2 * MiB - 1
      result = await load()
    })

    it('should fail naming both limits', () => {
      expect((result as Error).message).toBe(
        `MAX_PENDING_BYTES_PER_DEPLOYER (${2 * MiB - 1}) must be at least MAX_SCENE_SIZE (${2 * MiB} bytes).`
      )
    })
  })

  describe('and the scene size cap exactly fits the per-deployer staging budget', () => {
    beforeEach(async () => {
      settings.MAX_SCENE_SIZE = 2
      settings.MAX_PENDING_BYTES_PER_DEPLOYER = 2 * MiB
      result = await load()
    })

    it('should load the limits', () => {
      expect(result).not.toBeInstanceOf(Error)
    })
  })

  describe('and the per-minute byte rate is below one maximum-size request', () => {
    beforeEach(async () => {
      settings.MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE = DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1
      result = await load()
    })

    it('should fail naming the per-minute limit', () => {
      expect((result as Error).message).toBe(
        `MAX_PARTIAL_UPLOAD_BYTES_PER_MINUTE (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES - 1}) must fit one maximum-size upload (${DEFAULT_MAX_UPLOAD_SIZE_IN_BYTES} bytes).`
      )
    })
  })

  describe('and the server staging budget is below the per-deployer budget', () => {
    beforeEach(async () => {
      settings.MAX_SCENE_SIZE = 1
      settings.MAX_PENDING_BYTES_PER_DEPLOYER = 2 * MiB
      settings.MAX_PENDING_BYTES = 2 * MiB - 1
      result = await load()
    })

    it('should fail naming both budgets', () => {
      expect((result as Error).message).toBe(
        `MAX_PENDING_BYTES (${2 * MiB - 1}) must be at least MAX_PENDING_BYTES_PER_DEPLOYER (${2 * MiB}).`
      )
    })
  })
})
