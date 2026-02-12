export type RateLimitResult = {
  rateLimited: boolean
}

export interface IRateLimiterComponent {
  /**
   * Checks whether the subject has already exceeded the allowed number of failed attempts
   * within the time window. Does not modify state.
   *
   * @param worldName - The world being accessed
   * @param subject - The identifier for the requester (IP or wallet)
   * @returns Whether the subject is currently rate-limited
   */
  isRateLimited(worldName: string, subject: string): Promise<boolean>

  /**
   * Checks whether the subject has exceeded the allowed number of failed attempts
   * within the time window. If not rate-limited, records the new failed attempt.
   *
   * @param worldName - The world being accessed
   * @param subject - The identifier for the requester (IP or wallet)
   * @returns Whether the subject is rate-limited
   */
  recordFailedAttempt(worldName: string, subject: string): Promise<RateLimitResult>

  /**
   * Clears all recorded failed attempts for the subject on the given world.
   * Should be called on successful authentication.
   *
   * @param worldName - The world being accessed
   * @param subject - The identifier for the requester (IP or wallet)
   */
  clearAttempts(worldName: string, subject: string): Promise<void>
}
