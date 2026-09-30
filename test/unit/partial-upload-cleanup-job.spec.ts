import { createJobComponent } from '@dcl/job-component'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createPartialUploadCleanupJob } from '../../src/adapters/partial-upload-cleanup-job'
import { IPendingScenesManager } from '../../src/adapters/pending-scenes-manager/types'

jest.mock('@dcl/job-component', () => ({
  createJobComponent: jest.fn()
}))

const mockCreateJobComponent = createJobComponent as jest.Mock

describe('when creating the partial-upload cleanup job', () => {
  let pendingScenesManager: jest.Mocked<Pick<IPendingScenesManager, 'deleteExpired' | 'cleanupIntervalMs'>>
  let logs: ILoggerComponent
  let error: jest.Mock

  beforeEach(async () => {
    error = jest.fn()
    logs = { getLogger: () => ({ log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error }) }
    pendingScenesManager = { deleteExpired: jest.fn().mockResolvedValue(2), cleanupIntervalMs: 300_000 }
    mockCreateJobComponent.mockReturnValue({ start: jest.fn(), stop: jest.fn() })
    await createPartialUploadCleanupJob({
      logs,
      pendingScenesManager: pendingScenesManager as unknown as IPendingScenesManager
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should repeat the job every cleanup interval of the pending-scenes manager', () => {
    expect(mockCreateJobComponent).toHaveBeenCalledWith(
      { logs },
      expect.any(Function),
      300_000,
      expect.objectContaining({ repeat: true })
    )
  })

  describe('and the job runs', () => {
    beforeEach(async () => {
      await mockCreateJobComponent.mock.calls[0][1]()
    })

    it('should delete the expired uploads', () => {
      expect(pendingScenesManager.deleteExpired).toHaveBeenCalledTimes(1)
    })
  })

  describe('and a run fails', () => {
    beforeEach(() => {
      mockCreateJobComponent.mock.calls[0][3].onError(new Error('storage unavailable'))
    })

    it('should log the failure', () => {
      expect(error).toHaveBeenCalledWith('Failed to delete expired partial uploads: Error: storage unavailable')
    })
  })
})
