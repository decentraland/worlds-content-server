import { IConfigComponent } from '@well-known-components/interfaces'
import { IHttpServerComponent } from '@dcl/core-commons'
import { createInMemoryCacheComponent } from '@dcl/memory-cache-component'
import { createRateLimiterComponent, IRateLimiterComponent } from '@dcl/rate-limiter-component'
import { BaseComponents, GlobalContext } from '../../types'

/**
 * Counter keys held in memory. Its own cache instance: counter churn would evict whatever else
 * shared the LRU.
 */
const RATE_LIMITER_CACHE_MAX_KEYS = 50_000

/** Per client, per window. */
export const DEFAULT_POST_ENTITIES_RATE_LIMIT_MAX = 200
export const DEFAULT_POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * A second, independent bucket capping how many deployments one client can make in 24 hours. It
 * catches a caller that stays just under the per-minute burst but sustains that volume for hours.
 */
export const DEFAULT_POST_ENTITIES_DAILY_QUOTA_MAX = 300
const DAILY_QUOTA_WINDOW_SECONDS = 86_400

/**
 * Read a positive-integer setting, falling back to `defaultValue` when unset.
 *
 * The component validates these too, but its error names the option (`max`) rather than the
 * variable, and both mounts below set a `max` — so on its own it leaves an operator guessing which
 * one to fix. A `0` throws either way rather than flooring to `1`, which would be a silent
 * one-request-per-window outage that reads as working configuration.
 */
async function positiveIntConfig(config: IConfigComponent, name: string, defaultValue: number): Promise<number> {
  const value = await config.getNumber(name)
  if (value === undefined) {
    return defaultValue
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  }
  return value
}

/**
 * The rate limiter mounted on the HTTP routes. Counters live in memory, so the budget is per
 * process: with more than one task the effective allowance is multiplied by the task count.
 *
 * It has no lifecycle (no start/stop), so there is nothing to register for shutdown.
 */
export async function createHttpRateLimiterComponent({
  config,
  logs,
  metrics
}: Pick<BaseComponents, 'config' | 'logs' | 'metrics'>): Promise<IRateLimiterComponent<GlobalContext>> {
  const trustedClientIpHeader = await config.getString('TRUSTED_CLIENT_IP_HEADER')
  const logger = logs.getLogger('http-rate-limiter')

  // Warn at startup rather than per request: any client can send a forwarding header, so its
  // presence proves nothing and would let an outsider raise this.
  if (!trustedClientIpHeader) {
    logger.warn(
      'TRUSTED_CLIENT_IP_HEADER is unset. This server does not expose the socket address either, so ' +
        'every caller shares one bucket at a tenth of the limit — stricter than intended for legitimate ' +
        'traffic, and no per-client budget at all. Behind Cloudflare, set it to cf-connecting-ip. Watch ' +
        'the key_source label on rate_limiter_requests_total to confirm which identity is being used.'
    )
  }

  return createRateLimiterComponent<GlobalContext>(
    { cache: createInMemoryCacheComponent({ max: RATE_LIMITER_CACHE_MAX_KEYS }), logs, metrics },
    {
      // Process-level only. A budget set here would become the default for every mount, so each
      // endpoint's own lives at its mount.
      keyPrefix: 'worlds-content:rl',
      trustedClientIpHeader,
      // Only to match this server's error shape: everything else returns `{ error, message }` while
      // the component's built-in 429 is `{ ok, message }`. It still adds `Retry-After`.
      buildLimitExceededResponse: () => ({
        status: 429,
        body: { error: 'Too Many Requests', message: 'Too many requests, please try again later.' }
      })
    }
  )
}

/**
 * The middlewares guarding `POST /entities`. They must stay ahead of the multipart parser, which
 * buffers the whole upload: counting after it would let a throttled client spend the memory anyway.
 */
export async function createPostEntitiesRateLimitMiddlewares({
  config,
  rateLimiter
}: {
  config: IConfigComponent
  rateLimiter: IRateLimiterComponent<GlobalContext>
}): Promise<IHttpServerComponent.IRequestHandler<GlobalContext>[]> {
  const max = await positiveIntConfig(config, 'POST_ENTITIES_RATE_LIMIT_MAX', DEFAULT_POST_ENTITIES_RATE_LIMIT_MAX)
  const windowSeconds = await positiveIntConfig(
    config,
    'POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_POST_ENTITIES_RATE_LIMIT_WINDOW_SECONDS
  )

  const dailyQuotaMax = await positiveIntConfig(
    config,
    'POST_ENTITIES_DAILY_QUOTA_MAX',
    DEFAULT_POST_ENTITIES_DAILY_QUOTA_MAX
  )

  // Separate `name`s so the two count in independent buckets.
  return [
    rateLimiter.withRateLimitMiddleware({ name: '/entities burst', max, windowSeconds }),
    rateLimiter.withRateLimitMiddleware({
      name: '/entities daily-quota',
      max: dailyQuotaMax,
      windowSeconds: DAILY_QUOTA_WINDOW_SECONDS
    })
  ]
}
