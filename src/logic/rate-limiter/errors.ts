export class RateLimitedError extends Error {
  constructor(worldName: string) {
    super(`Too many failed shared-secret attempts for world "${worldName}". Try again later.`)
    this.name = 'RateLimitedError'
  }
}
