import { createInFlightUploadBudget, IInFlightUploadBudget } from '../../src/adapters/in-flight-upload-budget'
import { loadUploadLimits, UploadLimits } from '../../src/logic/upload-limits'
import { AppComponents } from '../../src/types'

describe('when creating the in-flight upload budget', () => {
  let uploadLimits: UploadLimits
  let observe: jest.Mock
  let metrics: AppComponents['metrics']
  let budget: IInFlightUploadBudget

  beforeEach(async () => {
    uploadLimits = {
      ...(await loadUploadLimits({ getNumber: jest.fn().mockResolvedValue(undefined) })),
      maxInFlightUploadBytes: 100,
      minUploadReservationBytes: 20,
      uploadFileOverheadBytes: 5,
      maxOrphanedUploadDirectories: 3
    }
    observe = jest.fn()
    metrics = { observe, increment: jest.fn() } as unknown as AppComponents['metrics']
    budget = await createInFlightUploadBudget({ metrics, uploadLimits })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should configure the aggregate byte capacity', () => {
    expect(budget.snapshot().capacity).toBe(100)
  })

  it('should configure the per-request minimum reservation', () => {
    expect(budget.snapshot().minUploadReservationBytes).toBe(20)
  })

  it('should derive the concurrent upload capacity from the byte budget', () => {
    expect(budget.snapshot().maxConcurrentUploads).toBe(5)
  })

  it('should configure the per-file charge', () => {
    expect(budget.snapshot().uploadFileOverheadBytes).toBe(5)
  })

  it('should configure the orphan-directory capacity', () => {
    expect(budget.snapshot().maxOrphanedUploadDirectories).toBe(3)
  })

  it('should report the aggregate byte capacity', () => {
    expect(observe).toHaveBeenCalledWith('multipart_upload_capacity_bytes', {}, 100)
  })

  describe('and an upload changes the shared budget state', () => {
    beforeEach(() => {
      budget.acquire(25)
    })

    it('should report the reserved bytes', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_reserved_bytes', {}, 25)
    })

    it('should report the active upload count', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_active', {}, 1)
    })
  })

  describe('and a small upload is admitted', () => {
    beforeEach(() => {
      budget.acquire(1)
    })

    it('should charge the per-request minimum reservation', () => {
      expect(budget.snapshot().reservedBytes).toBe(20)
    })
  })

  describe('and an upload adds a file', () => {
    beforeEach(() => {
      budget.acquire(25).lease?.resizeFiles(2)
    })

    it('should charge its payload plus the per-file overhead', () => {
      expect(budget.snapshot().reservedBytes).toBe(35)
    })
  })

  describe('and the uploads in flight would exceed the capacity', () => {
    let rejectionReason: string | undefined

    beforeEach(() => {
      budget.acquire(90)
      rejectionReason = budget.acquire(0).rejectionReason
    })

    it('should reject the new upload for lack of bytes', () => {
      expect(rejectionReason).toBe('bytes')
    })
  })

  describe('and the orphaned directories reach their limit', () => {
    let rejectionReason: string | undefined

    beforeEach(() => {
      for (let i = 0; i < 3; i++) {
        budget.acquire(0).lease?.release({ retainDirectory: true })
      }
      rejectionReason = budget.acquire(0).rejectionReason
    })

    it('should reject the new upload for lack of storage', () => {
      expect(rejectionReason).toBe('storage')
    })
  })

  describe('and an upload releases its shared budget lease', () => {
    beforeEach(() => {
      budget.acquire(25).lease?.release()
    })

    it('should report zero reserved bytes', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_reserved_bytes', {}, 0)
    })

    it('should report zero active uploads', () => {
      expect(observe).toHaveBeenLastCalledWith('multipart_upload_active', {}, 0)
    })
  })

  describe('and cleanup leaves uploaded bytes on disk', () => {
    beforeEach(() => {
      const lease = budget.acquire(25).lease
      lease?.resizeFiles(1)
      lease?.release({ retainBytes: 25, retainFiles: 1, retainDirectory: true })
    })

    it('should report the retained bytes and per-file charge as orphaned storage', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_bytes', {}, 30)
    })

    it('should report the retained temporary file', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_files', {}, 1)
    })

    it('should report the retained temporary directory', () => {
      expect(observe).toHaveBeenCalledWith('multipart_upload_orphaned_directories', {}, 1)
    })
  })
})
