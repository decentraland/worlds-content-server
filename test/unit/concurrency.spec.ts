import { IConfigComponent } from '@well-known-components/interfaces'
import { getConcurrency, mapWithConcurrency } from '../../src/logic/concurrency'

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
      concurrency = await getConcurrency(config, 'TEST_CONCURRENCY', 2)
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
      concurrency = await getConcurrency(config, 'TEST_CONCURRENCY', 2)
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
          const error = await getConcurrency(config, 'TEST_CONCURRENCY', 2).catch((caught) => caught)
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
})
