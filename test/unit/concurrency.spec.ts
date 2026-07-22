import { IConfigComponent } from '@well-known-components/interfaces'
import { getPositiveInteger, mapWithConcurrency, raceWithSignal } from '../../src/logic/concurrency'

describe('concurrency helpers', () => {
  describe('when tasks have uneven durations', () => {
    let executionOrder: string[]
    let results: number[]
    let releaseSlowTask: () => void
    let slowTask: Promise<void>

    beforeEach(async () => {
      executionOrder = []
      slowTask = new Promise<void>((resolve) => {
        releaseSlowTask = resolve
      })

      results = await mapWithConcurrency([0, 1, 2], 2, async (item) => {
        executionOrder.push(`start-${item}`)
        if (item === 0) {
          await slowTask
        } else if (item === 2) {
          releaseSlowTask()
        }
        executionOrder.push(`end-${item}`)
        return item
      })
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should start queued work as soon as any worker becomes available', () => {
      expect({ executionOrder, results }).toEqual({
        executionOrder: ['start-0', 'start-1', 'end-1', 'start-2', 'end-2', 'end-0'],
        results: [0, 1, 2]
      })
    })
  })

  describe('when one task fails while another task is still running', () => {
    let caughtError: unknown
    let completedItems: number[]
    let startedItems: number[]

    beforeEach(async () => {
      completedItems = []
      startedItems = []
      caughtError = await mapWithConcurrency([0, 1, 2], 2, async (item) => {
        startedItems.push(item)
        if (item === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          throw new Error('storage failed')
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        completedItems.push(item)
      }).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should wait for started work and leave queued work unstarted before rethrowing', () => {
      expect({
        completedItems,
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        startedItems
      }).toEqual({ completedItems: [1], error: 'storage failed', startedItems: [0, 1] })
    })
  })

  describe('when concurrency is configured', () => {
    let config: Pick<IConfigComponent, 'getNumber'>
    let getNumber: jest.Mock
    let concurrency: number

    beforeEach(async () => {
      getNumber = jest.fn().mockResolvedValue(7)
      config = { getNumber }
      concurrency = await getPositiveInteger(config, 'TEST_CONCURRENCY', 2)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should use the configured positive integer', () => {
      expect({ concurrency, requestedKey: getNumber.mock.calls[0][0] }).toEqual({
        concurrency: 7,
        requestedKey: 'TEST_CONCURRENCY'
      })
    })
  })

  describe('when concurrency is not configured', () => {
    let config: Pick<IConfigComponent, 'getNumber'>
    let concurrency: number

    beforeEach(async () => {
      config = { getNumber: jest.fn().mockResolvedValue(undefined) }
      concurrency = await getPositiveInteger(config, 'TEST_CONCURRENCY', 2)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should use the fallback value', () => {
      expect(concurrency).toBe(2)
    })
  })

  describe('when configured concurrency is invalid', () => {
    let errors: string[]
    let invalidValues: number[]

    beforeEach(async () => {
      invalidValues = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
      errors = await Promise.all(
        invalidValues.map(async (value) => {
          const config = { getNumber: jest.fn().mockResolvedValue(value) }
          const error = await getPositiveInteger(config, 'TEST_CONCURRENCY', 2).catch((caught) => caught)
          return error instanceof Error ? error.message : String(error)
        })
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject every non-positive or non-integer value', () => {
      expect(errors).toEqual(
        invalidValues.map((value) => `TEST_CONCURRENCY must be a positive safe integer, got ${value}`)
      )
    })
  })

  describe('when the worker-pool concurrency is invalid', () => {
    let errors: string[]
    let invalidValues: number[]

    beforeEach(async () => {
      invalidValues = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
      errors = await Promise.all(
        invalidValues.map(async (value) => {
          const error = await mapWithConcurrency([], value, async () => undefined).catch((caught) => caught)
          return error instanceof Error ? error.message : String(error)
        })
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject every non-positive or non-integer value', () => {
      expect(errors).toEqual(invalidValues.map((value) => `Concurrency must be a positive safe integer, got ${value}`))
    })
  })

  describe('when concurrent work is aborted', () => {
    let caughtError: unknown
    let completedItems: number[]
    let startedItems: number[]

    beforeEach(async () => {
      const controller = new AbortController()
      completedItems = []
      startedItems = []
      caughtError = await mapWithConcurrency(
        [0, 1, 2],
        2,
        async (item) => {
          startedItems.push(item)
          if (item === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            controller.abort(new Error('request aborted'))
          } else {
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
          }
          completedItems.push(item)
        },
        { signal: controller.signal }
      ).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should settle active work and leave queued work unstarted before rejecting with the abort reason', () => {
      expect({
        completedItems,
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        startedItems
      }).toEqual({ completedItems: [0, 1], error: 'request aborted', startedItems: [0, 1] })
    })
  })

  describe('when aborted work does not own request-scoped resources', () => {
    let caughtError: unknown
    let startedItems: number[]

    beforeEach(async () => {
      const controller = new AbortController()
      startedItems = []
      caughtError = await mapWithConcurrency(
        [0, 1],
        1,
        async (item) => {
          startedItems.push(item)
          controller.abort(new Error('deadline exceeded'))
          return new Promise<never>(() => undefined)
        },
        { signal: controller.signal, waitForActiveOnAbort: false }
      ).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject immediately without starting queued work', () => {
      expect({
        error: caughtError instanceof Error ? caughtError.message : caughtError,
        startedItems
      }).toEqual({ error: 'deadline exceeded', startedItems: [0] })
    })
  })

  describe('when a non-cancellable operation outlives its signal', () => {
    let caughtError: unknown

    beforeEach(async () => {
      const controller = new AbortController()
      const result = raceWithSignal(new Promise<never>(() => undefined), controller.signal)
      controller.abort(new Error('request ended'))
      caughtError = await result.catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the abort reason without waiting for the operation', () => {
      expect(caughtError).toEqual(new Error('request ended'))
    })
  })

  describe('when a raced operation fails before its signal aborts', () => {
    let caughtError: unknown

    beforeEach(async () => {
      const controller = new AbortController()
      caughtError = await raceWithSignal(Promise.reject(new Error('operation failed')), controller.signal).catch(
        (error) => error
      )
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the operation error instead of a cancellation', () => {
      expect(caughtError).toEqual(new Error('operation failed'))
    })
  })

  describe('when a raced operation starts under an already-aborted signal and fails later', () => {
    let caughtError: unknown
    let onUnhandledRejection: (reason: unknown) => void
    let unhandledRejections: unknown[]

    beforeEach(async () => {
      unhandledRejections = []
      onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
      process.on('unhandledRejection', onUnhandledRejection)
      const controller = new AbortController()
      controller.abort(new Error('aborted before racing'))
      let rejectOperation: (reason: Error) => void = () => undefined
      const operation = new Promise<never>((_resolve, reject) => (rejectOperation = reject))

      caughtError = await raceWithSignal(operation, controller.signal).catch((error) => error)
      rejectOperation(new Error('late failure'))
      // Unhandled rejections are detected once the microtask queue drains after the rejection.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setImmediate(resolve))
    })

    afterEach(() => {
      process.off('unhandledRejection', onUnhandledRejection)
      jest.resetAllMocks()
    })

    it('should reject with the abort reason while keeping the operation observed', () => {
      expect({ caughtError, unhandledRejections }).toEqual({
        caughtError: new Error('aborted before racing'),
        unhandledRejections: []
      })
    })
  })

  describe('when a signal is aborted with a null reason', () => {
    let midFlightError: unknown
    let preAbortedError: unknown

    beforeEach(async () => {
      // abort() and abort(undefined) natively substitute a DOMException reason, so null is the
      // only nullish reason a signal can carry. The helper deliberately normalizes it to a real
      // Error on both abort paths instead of throwing null like native throwIfAborted() would.
      const preAborted = new AbortController()
      preAborted.abort(null)
      preAbortedError = await raceWithSignal(new Promise<never>(() => undefined), preAborted.signal).catch(
        (error) => error
      )

      const midFlight = new AbortController()
      const racing = raceWithSignal(new Promise<never>(() => undefined), midFlight.signal)
      midFlight.abort(null)
      midFlightError = await racing.catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should normalize the nullish reason to the fallback error on both abort paths', () => {
      expect({ midFlightError, preAbortedError }).toEqual({
        midFlightError: new Error('Operation was aborted.'),
        preAbortedError: new Error('Operation was aborted.')
      })
    })
  })

  describe('when concurrent work starts with an already-aborted signal', () => {
    let caughtError: unknown
    let mapper: jest.Mock

    beforeEach(async () => {
      const controller = new AbortController()
      controller.abort(new Error('aborted before start'))
      mapper = jest.fn()
      caughtError = await mapWithConcurrency([0, 1], 2, mapper, { signal: controller.signal }).catch((error) => error)
    })

    afterEach(() => {
      jest.resetAllMocks()
    })

    it('should reject with the abort reason without starting any work', () => {
      expect({ caughtError, startedItems: mapper.mock.calls.length }).toEqual({
        caughtError: new Error('aborted before start'),
        startedItems: 0
      })
    })
  })
})
