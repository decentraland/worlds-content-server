import { IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { InvalidRequestError } from '@dcl/http-commons'
import {
  createDeploymentProcessingComponent,
  DeploymentProcessingAbortedError,
  DeploymentProcessingTimeoutError,
  MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS
} from '../../src/logic/deployment-processing'
import { metricDeclarations } from '../../src/metrics'
import { IDeploymentProcessingComponent } from '../../src/types'

describe('deployment processing component', () => {
  describe('when deployment settings are loaded during initialization', () => {
    let component: IDeploymentProcessingComponent
    let getNumber: jest.Mock
    let loggerInfo: jest.Mock

    beforeEach(async () => {
      const values: Record<string, number> = {
        DEPLOYMENT_STORAGE_CONCURRENCY: 3,
        DEPLOYMENT_HASH_CONCURRENCY: 2,
        DEPLOYMENT_FILE_INFO_CONCURRENCY: 8,
        DEPLOYMENT_PROCESSING_TIMEOUT_MS: 1000
      }
      getNumber = jest.fn(async (key: string) => values[key])
      loggerInfo = jest.fn()
      component = await createDeploymentProcessingComponent({
        config: { getNumber } as Pick<IConfigComponent, 'getNumber'> as IConfigComponent,
        logs: {
          getLogger: jest.fn().mockReturnValue({ info: loggerInfo })
        } as unknown as ILoggerComponent,
        metrics: { increment: jest.fn(), observe: jest.fn() } as unknown as IMetricsComponent<
          keyof typeof metricDeclarations
        >
      })
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should expose immutable validated settings and log their effective values', () => {
      expect({
        requestedKeys: getNumber.mock.calls.map(([key]) => key),
        settings: {
          fileInfoConcurrency: component.fileInfoConcurrency,
          hashConcurrency: component.hashConcurrency,
          storageConcurrency: component.storageConcurrency,
          timeoutMs: component.timeoutMs
        },
        loggedSettings: loggerInfo.mock.calls[0][1]
      }).toEqual({
        requestedKeys: [
          'DEPLOYMENT_STORAGE_CONCURRENCY',
          'DEPLOYMENT_HASH_CONCURRENCY',
          'DEPLOYMENT_FILE_INFO_CONCURRENCY',
          'DEPLOYMENT_PROCESSING_TIMEOUT_MS'
        ],
        settings: { fileInfoConcurrency: 8, hashConcurrency: 2, storageConcurrency: 3, timeoutMs: 1000 },
        loggedSettings: { fileInfoConcurrency: 8, hashConcurrency: 2, storageConcurrency: 3, timeoutMs: 1000 }
      })
    })
  })

  describe('when a deployment setting is invalid', () => {
    let caughtError: unknown

    beforeEach(async () => {
      caughtError = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(0) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn() } as unknown as ILoggerComponent,
        metrics: {} as IMetricsComponent<keyof typeof metricDeclarations>
      }).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should fail component initialization before requests are accepted', () => {
      expect(caughtError).toEqual(new Error('DEPLOYMENT_STORAGE_CONCURRENCY must be a positive safe integer, got 0'))
    })
  })

  describe('when the processing timeout exceeds the supported timer range', () => {
    let caughtError: unknown

    beforeEach(async () => {
      const getNumber = jest.fn(async (key: string) =>
        key === 'DEPLOYMENT_PROCESSING_TIMEOUT_MS' ? MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS + 1 : undefined
      )
      caughtError = await createDeploymentProcessingComponent({
        config: { getNumber } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn() } as unknown as ILoggerComponent,
        metrics: {} as IMetricsComponent<keyof typeof metricDeclarations>
      }).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should fail initialization instead of creating an overflowing Node timer', () => {
      expect(caughtError).toEqual(
        new Error(
          `DEPLOYMENT_PROCESSING_TIMEOUT_MS must be at most ${MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS}, got ${MAX_DEPLOYMENT_PROCESSING_TIMEOUT_MS + 1}`
        )
      )
    })
  })

  describe('when the processing deadline expires', () => {
    let abortContext: ReturnType<IDeploymentProcessingComponent['createAbortContext']>

    beforeEach(async () => {
      jest.useFakeTimers()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(10) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment: jest.fn(), observe: jest.fn() } as unknown as IMetricsComponent<
          keyof typeof metricDeclarations
        >
      })
      abortContext = component.createAbortContext()

      jest.advanceTimersByTime(11)
    })

    afterEach(() => {
      abortContext.dispose()
      jest.useRealTimers()
      jest.resetAllMocks()
    })

    it('should abort with a typed timeout error', () => {
      expect(abortContext.signal.reason).toEqual(new DeploymentProcessingTimeoutError(10))
    })
  })

  describe('when the parent request is aborted', () => {
    let abortContext: ReturnType<IDeploymentProcessingComponent['createAbortContext']>
    let caughtError: unknown
    let increment: jest.Mock

    beforeEach(async () => {
      increment = jest.fn()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(undefined) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment, observe: jest.fn() } as unknown as IMetricsComponent<keyof typeof metricDeclarations>
      })
      const parent = new AbortController()
      abortContext = component.createAbortContext(parent.signal)
      parent.abort(new DOMException('Client disconnected.', 'AbortError'))
      caughtError = await component
        .trackStage('total', 1, async () => {
          throw abortContext.signal.reason
        })
        .catch((error) => error)
    })

    afterEach(() => {
      abortContext.dispose()
      jest.resetAllMocks()
    })

    it('should propagate a typed abort and record an aborted outcome', () => {
      expect({
        error: caughtError,
        failure: increment.mock.calls[0]
      }).toEqual({
        error: new DeploymentProcessingAbortedError(new DOMException('Client disconnected.', 'AbortError')),
        failure: ['deployment_processing_failures', { outcome: 'aborted', stage: 'total' }]
      })
    })
  })

  describe('when a processing stage succeeds', () => {
    let increment: jest.Mock
    let observe: jest.Mock
    let result: string

    beforeEach(async () => {
      increment = jest.fn()
      observe = jest.fn()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(undefined) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment, observe } as unknown as IMetricsComponent<keyof typeof metricDeclarations>
      })

      result = await component.trackStage('metadata', 5, () =>
        component.trackWorker('metadata', async () => 'complete')
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should report stage duration, item count, and balanced activity', () => {
      expect({
        failures: increment.mock.calls.length,
        result,
        stageActivity: observe.mock.calls
          .filter(([metric]) => metric === 'deployment_processing_stage_active')
          .map(([, , value]) => value),
        stageItems: observe.mock.calls.find(([metric]) => metric === 'deployment_processing_stage_items')?.[2],
        workerActivity: observe.mock.calls
          .filter(([metric]) => metric === 'deployment_processing_worker_active')
          .map(([, , value]) => value)
      }).toEqual({
        failures: 0,
        result: 'complete',
        stageActivity: [1, 0],
        stageItems: 5,
        workerActivity: [1, 0]
      })
    })
  })

  describe('when a processing stage times out', () => {
    let caughtError: unknown
    let increment: jest.Mock
    let observe: jest.Mock

    beforeEach(async () => {
      increment = jest.fn()
      observe = jest.fn()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(undefined) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment, observe } as unknown as IMetricsComponent<keyof typeof metricDeclarations>
      })

      caughtError = await component
        .trackStage('storage', 2, async () => {
          throw new DeploymentProcessingTimeoutError(10)
        })
        .catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should report a timeout failure and duration while balancing stage activity', () => {
      expect({
        durationLabels: observe.mock.calls.find(
          ([metric]) => metric === 'deployment_processing_stage_duration_seconds'
        )?.[1],
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        failure: increment.mock.calls[0],
        stageActivity: observe.mock.calls
          .filter(([metric]) => metric === 'deployment_processing_stage_active')
          .map(([, , value]) => value)
      }).toEqual({
        durationLabels: { outcome: 'timeout', stage: 'storage' },
        error: 'Deployment processing exceeded the 10ms deadline.',
        failure: ['deployment_processing_failures', { outcome: 'timeout', stage: 'storage' }],
        stageActivity: [1, 0]
      })
    })
  })

  describe('when a processing stage fails because the request is invalid', () => {
    let caughtError: unknown
    let increment: jest.Mock

    beforeEach(async () => {
      increment = jest.fn()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(undefined) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment, observe: jest.fn() } as unknown as IMetricsComponent<keyof typeof metricDeclarations>
      })

      caughtError = await component
        .trackStage('total', 1, async () => {
          throw new InvalidRequestError('The entity file is not valid JSON.')
        })
        .catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should report a client-error outcome so operational alerts exclude client mistakes', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        failure: increment.mock.calls[0]
      }).toEqual({
        error: 'The entity file is not valid JSON.',
        failure: ['deployment_processing_failures', { outcome: 'client-error', stage: 'total' }]
      })
    })
  })

  describe('when a Node API consumes the signal and rejects with its own abort error', () => {
    let increment: jest.Mock

    beforeEach(async () => {
      increment = jest.fn()
      const component = await createDeploymentProcessingComponent({
        config: { getNumber: jest.fn().mockResolvedValue(undefined) } as unknown as IConfigComponent,
        logs: { getLogger: jest.fn().mockReturnValue({ info: jest.fn() }) } as unknown as ILoggerComponent,
        metrics: { increment, observe: jest.fn() } as unknown as IMetricsComponent<keyof typeof metricDeclarations>
      })
      // fs rejects with a plain-Error AbortError carrying the signal reason in `cause` instead of
      // being the reason itself, exactly like fs.promises.readFile with an aborted signal.
      const timeoutAbortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        cause: new DeploymentProcessingTimeoutError(10)
      })
      const disconnectAbortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        cause: new DeploymentProcessingAbortedError(new Error('client disconnected'))
      })

      await component
        .trackStage('hash', 1, async () => {
          throw timeoutAbortError
        })
        .catch(() => undefined)
      await component
        .trackStage('hash', 1, async () => {
          throw disconnectAbortError
        })
        .catch(() => undefined)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should classify the failure by the cancellation it wraps instead of an operational error', () => {
      expect(increment.mock.calls).toEqual([
        ['deployment_processing_failures', { outcome: 'timeout', stage: 'hash' }],
        ['deployment_processing_failures', { outcome: 'aborted', stage: 'hash' }]
      ])
    })
  })
})
