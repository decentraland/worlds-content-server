import { ISocialServiceComponent, MemberCommunitiesResponse } from '../../src/adapters/social-service'

export function createMockSocialService(): jest.Mocked<ISocialServiceComponent> {
  return {
    getMemberCommunities: jest.fn().mockResolvedValue({ communities: [] } as MemberCommunitiesResponse)
  }
}
