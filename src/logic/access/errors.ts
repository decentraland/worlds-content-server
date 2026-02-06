export class InvalidAccessTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAccessTypeError'
  }
}

export class InvalidAllowListSettingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAllowListSettingError'
  }
}

export class UnauthorizedCommunityError extends Error {
  constructor(communities: string[]) {
    super(`You are not a member of the following communities: ${communities.join(', ')}.`)
    this.name = 'UnauthorizedCommunityError'
  }
}

export class NotAllowListAccessError extends Error {
  constructor(worldName: string) {
    super(`World "${worldName}" does not have allow-list access type. Cannot add or remove wallets.`)
    this.name = 'NotAllowListAccessError'
  }
}
