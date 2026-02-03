export class WorldBlockedError extends Error {
  constructor(worldName: string, blockedSince: Date) {
    super(`World "${worldName}" has been blocked since ${blockedSince} as it exceeded its allowed storage space.`)
    this.name = 'WorldBlockedError'
  }
}

export class WorldNotFoundError extends Error {
  constructor(worldName: string) {
    super(`World "${worldName}" not found.`)
    this.name = 'WorldNotFoundError'
  }
}
