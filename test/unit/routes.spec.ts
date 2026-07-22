import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createMultipartUploadGuard, MultipartUploadGuard } from '../../src/controllers/routes'
import { BaseComponents } from '../../src/types'

describe('createMultipartUploadGuard', () => {
  let components: Pick<BaseComponents, 'config' | 'logs' | 'metrics'>
  let config: jest.Mocked<IConfigComponent>
  let observe: jest.Mock
  let increment: jest.Mock
  let warn: jest.Mock

  beforeEach(() => {
    config = {
      getNumber: jest.fn(async (key: string) => {
        const values: Record<string, number> = {
          MAX_IN_FLIGHT_UPLOAD_BYTES: 100,
          MAX_CONCURRENT_UPLOADS: 2,
          MAX_IN_FLIGHT_UPLOAD_FILES: 10,
          MAX_ORPHANED_UPLOAD_DIRECTORIES: 3,
          MULTIPART_UPLOAD_TIMEOUT_MS: 300
        }
        return values[key]
      })
    } as unknown as jest.Mocked<IConfigComponent>
    observe = jest.fn()
    increment = jest.fn()
    warn = jest.fn()
    components = {
      config,
      logs: {
        getLogger: jest.fn().mockReturnValue({ warn })
      } as unknown as ILoggerComponent,
      metrics: { observe, increment } as unknown as BaseComponents['metrics']
    }
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when configured limits are provided', () => {
    let guard: MultipartUploadGuard

    beforeEach(async () => {
      guard = await createMultipartUploadGuard(components)
    })

    it('should configure the aggregate byte capacity', () => {
      expect(guard.inFlightUploadBudget.snapshot().capacity).toBe(100)
    })

    it('should configure the concurrent upload capacity', () => {
      expect(guard.inFlightUploadBudget.snapshot().maxConcurrentUploads).toBe(2)
    })

    it('should configure the aggregate temporary-file capacity', () => {
      expect(guard.inFlightUploadBudget.snapshot().maxInFlightUploadFiles).toBe(10)
    })

    it('should configure the orphan-directory capacity', () => {
      expect(guard.inFlightUploadBudget.snapshot().maxOrphanedUploadDirectories).toBe(3)
    })

    it('should configure the upload timeout', () => {
      expect(guard.uploadTimeoutMs).toBe(300)
    })

    it('should read the byte limit setting', () => {
      expect(config.getNumber).toHaveBeenCalledWith('MAX_IN_FLIGHT_UPLOAD_BYTES')
    })

    it('should read the concurrency limit setting', () => {
      expect(config.getNumber).toHaveBeenCalledWith('MAX_CONCURRENT_UPLOADS')
    })

    it('should read the temporary-file limit setting', () => {
      expect(config.getNumber).toHaveBeenCalledWith('MAX_IN_FLIGHT_UPLOAD_FILES')
    })

    it('should read the orphan-directory limit setting', () => {
      expect(config.getNumber).toHaveBeenCalledWith('MAX_ORPHANED_UPLOAD_DIRECTORIES')
    })

    it('should read the timeout setting', () => {
      expect(config.getNumber).toHaveBeenCalledWith('MULTIPART_UPLOAD_TIMEOUT_MS')
    })
  })

  describe('when an upload changes the shared budget state', () => {
    let guard: MultipartUploadGuard

    beforeEach(async () => {
      guard = await createMultipartUploadGuard(components)
      guard.inFlightUploadBudget.acquire(25)
    })

    it('should report the reserved bytes', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_reserved_bytes', {}, 25)
    })

    it('should report the active upload count', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_active', {}, 1)
    })
  })

  describe('when an upload releases its shared budget lease', () => {
    beforeEach(async () => {
      const guard = await createMultipartUploadGuard(components)
      const acquisition = guard.inFlightUploadBudget.acquire(25)

      acquisition.lease!.release()
    })

    it('should report zero reserved bytes', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_reserved_bytes', {}, 0)
    })

    it('should report zero active uploads', () => {
      expect(observe).toHaveBeenLastCalledWith('multipart_upload_active', {}, 0)
    })
  })

  describe('when cleanup leaves uploaded bytes on disk', () => {
    beforeEach(async () => {
      const guard = await createMultipartUploadGuard(components)
      const acquisition = guard.inFlightUploadBudget.acquire(25)

      acquisition.lease!.resizeFiles(1)
      acquisition.lease!.release({ retainBytes: 25, retainFiles: 1, retainDirectory: true })
    })

    it('should report the retained bytes as orphaned storage', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_bytes', {}, 25)
    })

    it('should report the retained temporary file', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_files', {}, 1)
    })

    it('should report the retained temporary directory', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_directories', {}, 1)
    })
  })

  describe('when an upload completes', () => {
    let guard: MultipartUploadGuard

    beforeEach(async () => {
      guard = await createMultipartUploadGuard(components)
      guard.onTelemetry({
        kind: 'completed',
        route: 'entities',
        actualBytes: 42,
        contentLengthPresent: false,
        snapshot: guard.inFlightUploadBudget.snapshot()
      })
    })

    it('should record the actual upload size and outcome', () => {
      expect(observe).toHaveBeenCalledWith(
        'multipart_upload_size_bytes',
        { route: 'entities', content_length: 'absent', outcome: 'completed' },
        42
      )
    })

    it('should not increment the rejection counter', () => {
      expect(increment).not.toHaveBeenCalled()
    })
  })

  describe('when an upload is rejected', () => {
    let guard: MultipartUploadGuard

    beforeEach(async () => {
      guard = await createMultipartUploadGuard(components)
      guard.onTelemetry({
        kind: 'rejected',
        route: 'world-settings',
        reason: 'concurrency',
        actualBytes: 10,
        contentLengthPresent: true,
        snapshot: guard.inFlightUploadBudget.snapshot()
      })
    })

    it('should record the rejected upload size and outcome', () => {
      expect(observe).toHaveBeenCalledWith(
        'multipart_upload_size_bytes',
        { route: 'world-settings', content_length: 'present', outcome: 'rejected' },
        10
      )
    })

    it('should increment the labeled rejection counter', () => {
      expect(increment).toHaveBeenCalledWith('multipart_upload_rejections', {
        route: 'world-settings',
        reason: 'concurrency'
      })
    })

    it('should log the rejection with limiter state', () => {
      expect(warn).toHaveBeenCalledWith(
        'Multipart upload rejected',
        expect.objectContaining({
          route: 'world-settings',
          reason: 'concurrency',
          capacity: 100,
          maxConcurrentUploads: 2
        })
      )
    })
  })

  describe('when a temporary upload directory cannot be removed', () => {
    let guard: MultipartUploadGuard

    beforeEach(async () => {
      guard = await createMultipartUploadGuard(components)
      guard.onCleanupError({
        route: 'entities',
        error: new Error('disk cleanup failed'),
        attempt: 0,
        willRetry: true
      })
    })

    it('should increment the cleanup-failure counter for the route', () => {
      expect(increment).toHaveBeenCalledWith('multipart_upload_cleanup_failures', { route: 'entities' })
    })

    it('should log the cleanup failure', () => {
      expect(warn).toHaveBeenCalledWith('Failed to clean up multipart upload directory', {
        route: 'entities',
        error: 'disk cleanup failed',
        attempt: 0,
        willRetry: 'true'
      })
    })
  })

  describe('when a background cleanup retry fails', () => {
    beforeEach(async () => {
      const guard = await createMultipartUploadGuard(components)
      guard.onCleanupError({
        route: 'entities',
        error: new Error('retry failed'),
        attempt: 1,
        willRetry: false
      })
    })

    it('should count a retry attempt without counting another orphaned directory', () => {
      expect({
        initialFailures: increment.mock.calls.filter(([name]) => name === 'multipart_upload_cleanup_failures').length,
        retryFailures: increment.mock.calls.filter(([name]) => name === 'multipart_upload_cleanup_retry_failures')
          .length
      }).toEqual({ initialFailures: 0, retryFailures: 1 })
    })
  })
})
