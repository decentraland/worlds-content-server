import { ILoggerComponent } from '@well-known-components/interfaces'
import { buildInFlightUploadBudget, InFlightUploadBudgetSnapshot } from '../../src/adapters/in-flight-upload-budget'
import { createMultipartUploadTelemetry, MultipartUploadTelemetry } from '../../src/controllers/multipart'
import { BaseComponents } from '../../src/types'

describe('createMultipartUploadTelemetry', () => {
  let components: Pick<BaseComponents, 'logs' | 'metrics'>
  let observe: jest.Mock
  let increment: jest.Mock
  let warn: jest.Mock
  let snapshot: InFlightUploadBudgetSnapshot
  let telemetry: MultipartUploadTelemetry

  beforeEach(() => {
    observe = jest.fn()
    increment = jest.fn()
    warn = jest.fn()
    components = {
      logs: {
        getLogger: jest.fn().mockReturnValue({ warn })
      } as unknown as ILoggerComponent,
      metrics: { observe, increment } as unknown as BaseComponents['metrics']
    }
    snapshot = buildInFlightUploadBudget(100, {
      minUploadReservationBytes: 20,
      uploadFileOverheadBytes: 5,
      maxOrphanedUploadDirectories: 3
    }).snapshot()
    telemetry = createMultipartUploadTelemetry(components)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when an upload completes', () => {
    beforeEach(() => {
      telemetry.onTelemetry({
        kind: 'completed',
        route: 'entities',
        actualBytes: 42,
        contentLengthPresent: false,
        snapshot
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
    beforeEach(() => {
      telemetry.onTelemetry({
        kind: 'rejected',
        route: 'world-settings',
        reason: 'bytes',
        actualBytes: 10,
        contentLengthPresent: true,
        snapshot
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
        reason: 'bytes'
      })
    })

    it('should log the rejection with limiter state', () => {
      expect(warn).toHaveBeenCalledWith(
        'Multipart upload rejected',
        expect.objectContaining({
          route: 'world-settings',
          reason: 'bytes',
          capacity: 100,
          maxConcurrentUploads: 5,
          minUploadReservationBytes: 20,
          uploadFileOverheadBytes: 5
        })
      )
    })
  })

  describe('when a temporary upload directory cannot be removed', () => {
    beforeEach(() => {
      telemetry.onCleanupError({
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
    beforeEach(() => {
      telemetry.onCleanupError({
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
