export class ContentLockTimeoutError extends Error {
  constructor() {
    super('The content lock is still busy, please retry shortly.')
    this.name = 'ContentLockTimeoutError'
  }
}
