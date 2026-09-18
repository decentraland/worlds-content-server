/**
 * The rate limiter on `POST /entities` cannot resolve a client address under test: requests carry
 * no trusted forwarding header and the server does not expose the socket address, so they all share
 * the fallback bucket at a tenth of the configured limit. Deploy-heavy suites spend that in a few
 * seconds.
 *
 * Raise the allowance out of the way for suites that are not about rate limiting. The ones that
 * are set their own values, which win: this runs before the spec module is loaded.
 */
process.env.POST_ENTITIES_RATE_LIMIT_MAX ??= '100000'
process.env.POST_ENTITIES_DAILY_QUOTA_MAX ??= '100000'
