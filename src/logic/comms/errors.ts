export class WorldNotFoundError extends Error {
  constructor(worldName: string) {
    super(`World "${worldName}" not found.`)
    this.name = 'WorldNotFoundError'
  }
}

export class SceneNotFoundError extends Error {
  constructor(worldName: string, sceneId: string) {
    super(`Scene "${sceneId}" not found in world "${worldName}".`)
    this.name = 'SceneNotFoundError'
  }
}

export class InvalidWorldError extends Error {
  constructor(worldName: string) {
    super(`World "${worldName}" is invalid or blocked.`)
    this.name = 'InvalidWorldError'
  }
}

export class InvalidAccessError extends Error {
  constructor(worldName: string) {
    super(`You are not allowed to access world "${worldName}".`)
    this.name = 'NotAuthorizedError'
  }
}
