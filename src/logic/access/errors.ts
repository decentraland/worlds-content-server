export class InvalidAccessTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAccessTypeError'
  }
}
