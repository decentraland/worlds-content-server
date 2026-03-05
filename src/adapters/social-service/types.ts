import { EthAddress } from '@dcl/schemas'

export type MemberCommunitiesResponse = {
  communities: Array<{ id: string }>
}

export type PlayerBanResponse = {
  isBanned: boolean
}

export interface ISocialServiceComponent {
  /**
   * POST /v1/members/:address/communities
   * Validates which communities from the provided list the user is a member of.
   */
  getMemberCommunities(address: EthAddress, communityIds: string[]): Promise<MemberCommunitiesResponse>

  /**
   * GET /v1/moderation/users/:address/bans
   * Checks whether a user is platform-banned.
   * Fails open: returns false on any error.
   */
  isPlayerBanned(address: string): Promise<boolean>
}
