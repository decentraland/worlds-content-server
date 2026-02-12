import { ICacheStorageComponent } from '@dcl/core-commons'
import { IConfigComponent } from '@well-known-components/interfaces'
import { createRateLimiterComponent, IRateLimiterComponent } from '../../src/logic/rate-limiter'
import { createRedisMock } from '../mocks/redis-mock'
import { createMockedConfig } from '../mocks/config-mock'

describe('RateLimiterComponent', () => {
  let redis: jest.Mocked<ICacheStorageComponent>
  let config: jest.Mocked<IConfigComponent>
  let rateLimiter: IRateLimiterComponent

  const worldName = 'test-world'
  const subject = '1.2.3.4'

  beforeEach(async () => {
    redis = createRedisMock()
    config = createMockedConfig()
    config.getNumber.mockResolvedValue(3)

    rateLimiter = await createRateLimiterComponent({ config, redis })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('isRateLimited', () => {
    describe('when there are no attempts', () => {
      beforeEach(() => {
        redis.get.mockResolvedValue(undefined)
      })

      it('should return false', async () => {
        const result = await rateLimiter.isRateLimited(worldName, subject)

        expect(result).toBe(false)
      })
    })

    describe('when attempts are below the limit', () => {
      beforeEach(() => {
        const now = Date.now()
        redis.get.mockResolvedValue({
          attempts: [now - 10000, now - 20000]
        })
      })

      it('should return false', async () => {
        const result = await rateLimiter.isRateLimited(worldName, subject)

        expect(result).toBe(false)
      })
    })

    describe('when attempts have reached the limit', () => {
      beforeEach(() => {
        const now = Date.now()
        redis.get.mockResolvedValue({
          attempts: [now - 10000, now - 20000, now - 30000]
        })
      })

      it('should return true', async () => {
        const result = await rateLimiter.isRateLimited(worldName, subject)

        expect(result).toBe(true)
      })
    })

    describe('when Redis get fails', () => {
      beforeEach(() => {
        redis.get.mockRejectedValue(new Error('Redis error'))
      })

      it('should return false (fail-open)', async () => {
        const result = await rateLimiter.isRateLimited(worldName, subject)

        expect(result).toBe(false)
      })
    })

    describe('when checking the key format', () => {
      beforeEach(() => {
        redis.get.mockResolvedValue(undefined)
      })

      it('should use lowercase world name and subject in the key', async () => {
        await rateLimiter.isRateLimited('MyWorld', 'AbCdEf')

        expect(redis.get).toHaveBeenCalledWith(expect.stringContaining('myworld:abcdef'))
      })
    })
  })

  describe('recordFailedAttempt', () => {
    describe('when there are no prior attempts', () => {
      it('should record the attempt and return not rate-limited', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(false)
        expect(redis.set).toHaveBeenCalledWith(
          expect.stringContaining(`${worldName}:${subject}`),
          { attempts: [expect.any(Number)] },
          70
        )
      })
    })

    describe('when there are prior attempts below the limit', () => {
      beforeEach(() => {
        const now = Date.now()
        redis.get.mockResolvedValue({
          attempts: [now - 10000, now - 20000]
        })
      })

      it('should record the new attempt and return not rate-limited', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(false)
        expect(redis.set).toHaveBeenCalledWith(
          expect.stringContaining(`${worldName}:${subject}`),
          { attempts: expect.arrayContaining([expect.any(Number)]) },
          70
        )
        // 2 existing + 1 new = 3 attempts stored
        const storedAttempts = (redis.set.mock.calls[0][1] as { attempts: number[] }).attempts
        expect(storedAttempts).toHaveLength(3)
      })
    })

    describe('when attempts have reached the limit', () => {
      beforeEach(() => {
        const now = Date.now()
        redis.get.mockResolvedValue({
          attempts: [now - 10000, now - 20000, now - 30000]
        })
      })

      it('should return rate-limited', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(true)
      })

      it('should not record an additional attempt', async () => {
        await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(redis.set).not.toHaveBeenCalled()
      })
    })

    describe('when old attempts fall outside the 60s window', () => {
      beforeEach(() => {
        redis.get.mockResolvedValue({
          attempts: [Date.now() - 120000, Date.now() - 90000, Date.now() - 80000]
        })
      })

      it('should prune them and return not rate-limited', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(false)
        const storedAttempts = (redis.set.mock.calls[0][1] as { attempts: number[] }).attempts
        // Only the new attempt should remain after pruning
        expect(storedAttempts).toHaveLength(1)
      })
    })

    describe('when lock acquisition fails', () => {
      beforeEach(() => {
        redis.acquireLock.mockRejectedValue(new Error('Lock not acquired'))
      })

      it('should return not rate-limited and not record anything', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(false)
        expect(redis.set).not.toHaveBeenCalled()
      })
    })

    describe('when the max attempts config is customized', () => {
      beforeEach(async () => {
        config.getNumber.mockResolvedValue(1)
        rateLimiter = await createRateLimiterComponent({ config, redis })

        const now = Date.now()
        redis.get.mockResolvedValue({
          attempts: [now - 10000]
        })
      })

      it('should respect the configured limit', async () => {
        const result = await rateLimiter.recordFailedAttempt(worldName, subject)

        expect(result.rateLimited).toBe(true)
      })
    })

    it('should use lowercase world name and subject in the key', async () => {
      await rateLimiter.recordFailedAttempt('MyWorld', 'AbCdEf')

      expect(redis.acquireLock).toHaveBeenCalledWith(expect.stringContaining('myworld:abcdef'), expect.any(Object))
      expect(redis.get).toHaveBeenCalledWith(expect.stringContaining('myworld:abcdef'))
    })

    it('should always release the lock in the finally block', async () => {
      await rateLimiter.recordFailedAttempt(worldName, subject)

      expect(redis.tryReleaseLock).toHaveBeenCalled()
    })
  })

  describe('clearAttempts', () => {
    it('should remove the attempts key from redis', async () => {
      await rateLimiter.clearAttempts(worldName, subject)

      expect(redis.remove).toHaveBeenCalledWith(expect.stringContaining(`${worldName}:${subject}`))
    })

    it('should use lowercase world name and subject in the key', async () => {
      await rateLimiter.clearAttempts('MyWorld', 'AbCdEf')

      expect(redis.remove).toHaveBeenCalledWith(expect.stringContaining('myworld:abcdef'))
    })
  })
})
