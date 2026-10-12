/** Thrown once the session holding the migrations lock is gone, so no further migration SQL runs unlocked. */
export class MigrationsLockLostError extends Error {
  constructor() {
    super('Lost the migrations lock, stopping migrations')
    this.name = 'MigrationsLockLostError'
  }
}
