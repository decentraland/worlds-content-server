export class InvalidAccessTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAccessTypeError'
  }
}

export class UnauthorizedCommunityError extends Error {
  constructor(communities: string[]) {
    super(`You are not a member of the following communities: ${communities.join(', ')}.`)
    this.name = 'UnauthorizedCommunityError'
  }
}
