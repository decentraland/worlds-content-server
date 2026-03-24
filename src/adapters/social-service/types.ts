import { EthAddress } from '@dcl/schemas'

export type MemberCommunitiesResponse = {
  communities: Array<{ id: string }>
}

export interface ISocialServiceComponent {
  /**
   * POST /v1/members/:address/communities
   * Validates which communities from the provided list the user is a member of.
   */
  getMemberCommunities(address: EthAddress, communityIds: string[]): Promise<MemberCommunitiesResponse>
}
