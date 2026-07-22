import { IDeploymentProcessingComponent } from '../../src/types'

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
      dispose: jest.fn()
    })),
    trackStage: jest.fn(async (_stage, _items, operation) => operation()),
    trackWorker: jest.fn(async (_stage, operation) => operation()),
    ...overrides
  }
  return component as unknown as jest.Mocked<IDeploymentProcessingComponent>
}
