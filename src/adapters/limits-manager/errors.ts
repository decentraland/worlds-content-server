export class WorldOwnerNotFoundError extends Error {
  constructor(public readonly worldName: string) {
    super(`Could not determine owner for world ${worldName}`)
    this.name = 'WorldOwnerNotFoundError'
  }
}
