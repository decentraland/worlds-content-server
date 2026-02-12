export const DEFAULT_MAX_ATTEMPTS_PER_MINUTE = 3
export const RATE_LIMIT_WINDOW_SECONDS = 60
export const RATE_LIMIT_TTL_SECONDS = 70
export const LOCK_TTL_MS = 5000
export const LOCK_RETRIES = 3
export const LOCK_RETRY_DELAY_MS = 100
export const ATTEMPTS_KEY_PREFIX = 'shared-secret:attempts'
export const LOCK_KEY_PREFIX = 'shared-secret:attempts:lock'
