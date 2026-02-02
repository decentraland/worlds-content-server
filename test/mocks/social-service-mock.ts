import { ISocialServiceAdapter, MemberCommunitiesResponse } from '../../src/adapters/social-service'

export function createMockSocialService(): jest.Mocked<ISocialServiceAdapter> {
  return {
    getMemberCommunities: jest.fn().mockResolvedValue({ communities: [] } as MemberCommunitiesResponse),
    isMemberFromCommunity: jest.fn().mockResolvedValue(false)
  }
}
