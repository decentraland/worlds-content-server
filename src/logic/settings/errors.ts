export class UnauthorizedError extends Error {
  constructor(message: string = 'Unauthorized. You do not have permission to update settings for this world.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class WorldNotFoundError extends Error {
  constructor(worldName: string) {
    super(`World "${worldName}" not found or has no settings configured.`)
    this.name = 'WorldNotFoundError'
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
