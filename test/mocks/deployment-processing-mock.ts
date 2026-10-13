import { DeploymentProcessingStage, IDeploymentProcessingComponent } from '../../src/types'

export function createDeploymentProcessingMock(
  overrides?: Partial<jest.Mocked<IDeploymentProcessingComponent>>
): jest.Mocked<IDeploymentProcessingComponent> {
  const component = {
    fileInfoConcurrency: 64,
    hashConcurrency: 4,
    storageConcurrency: 10,
    timeoutMs: 300_000,
    createAbortContext: jest.fn((parentSignal?: AbortSignal) => ({
      signal: parentSignal ?? new AbortController().signal,
      deadlineAt: Date.now() + 300_000,
      dispose: jest.fn()
    })),
    trackStage: jest.fn(async (_stage, _items, operation) => operation()),
    trackWorker: jest.fn(async (_stage, operation) => operation()),
    ...overrides
  }
  return component as unknown as jest.Mocked<IDeploymentProcessingComponent>
}

export type StageRecorder = {
  trackStage: jest.MockedFunction<IDeploymentProcessingComponent['trackStage']>
  /** Stages whose operation is running right now, outermost first. */
  openStages(): DeploymentProcessingStage[]
}

/** A trackStage double that tracks open stages, so a test can tell which stage wrapped an operation. */
export function createStageRecorder(): StageRecorder {
  const open: DeploymentProcessingStage[] = []
  const trackStage = jest.fn(
    async <T>(stage: DeploymentProcessingStage, _items: number, operation: () => Promise<T>): Promise<T> => {
      open.push(stage)
      try {
        return await operation()
      } finally {
        open.splice(open.lastIndexOf(stage), 1)
      }
    }
  ) as StageRecorder['trackStage']
  return { trackStage, openStages: () => [...open] }
}
