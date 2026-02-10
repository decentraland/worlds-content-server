import { AppComponents } from '../../types'
import { IRateLimiterComponent, RateLimitResult } from './types'
import {
  ATTEMPTS_KEY_PREFIX,
  DEFAULT_MAX_ATTEMPTS_PER_MINUTE,
  LOCK_KEY_PREFIX,
  LOCK_RETRY_DELAY_MS,
  LOCK_RETRIES,
  LOCK_TTL_MS,
  RATE_LIMIT_TTL_SECONDS,
  RATE_LIMIT_WINDOW_SECONDS
} from './constants'

type StoredAttempts = {
  attempts: number[]
}

export async function createRateLimiterComponent({
  config,
  redis
}: Pick<AppComponents, 'config' | 'redis'>): Promise<IRateLimiterComponent> {
  const maxAttempts =
    (await config.getNumber('SHARED_SECRET_MAX_ATTEMPTS_PER_MINUTE')) ?? DEFAULT_MAX_ATTEMPTS_PER_MINUTE

  function buildAttemptsKey(worldName: string, subject: string): string {
    return `${ATTEMPTS_KEY_PREFIX}:${worldName.toLowerCase()}:${subject.toLowerCase()}`
  }

  function buildLockKey(worldName: string, subject: string): string {
    return `${LOCK_KEY_PREFIX}:${worldName.toLowerCase()}:${subject.toLowerCase()}`
  }

  async function recordFailedAttempt(worldName: string, subject: string): Promise<RateLimitResult> {
    const attemptsKey = buildAttemptsKey(worldName, subject)
    const lockKey = buildLockKey(worldName, subject)

    try {
      await redis.acquireLock(lockKey, {
        ttlInMilliseconds: LOCK_TTL_MS,
        retries: LOCK_RETRIES,
        retryDelayInMilliseconds: LOCK_RETRY_DELAY_MS
      })

      const now = Date.now()
      const windowStart = now - RATE_LIMIT_WINDOW_SECONDS * 1000
      const stored = await redis.get<StoredAttempts>(attemptsKey)
      const recentAttempts = stored ? stored.attempts.filter((ts) => ts > windowStart) : []

      if (recentAttempts.length >= maxAttempts) {
        return { rateLimited: true }
      }

      recentAttempts.push(now)
      await redis.set<StoredAttempts>(attemptsKey, { attempts: recentAttempts }, RATE_LIMIT_TTL_SECONDS)

      return { rateLimited: false }
    } catch {
      // If lock acquisition fails, don't block the caller — just skip tracking
      return { rateLimited: false }
    } finally {
      await redis.tryReleaseLock(lockKey)
    }
  }

  async function clearAttempts(worldName: string, subject: string): Promise<void> {
    const attemptsKey = buildAttemptsKey(worldName, subject)
    await redis.remove(attemptsKey)
  }

  return {
    recordFailedAttempt,
    clearAttempts
  }
}
