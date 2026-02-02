import { ISocialServiceClient, ValidCommunitiesResponse } from '../../src/adapters/social-service-client'
import { EthAddress } from '@dcl/schemas'

export function createMockSocialServiceClient(): jest.Mocked<ISocialServiceClient> {
  return {
    getValidCommunities: jest.fn().mockResolvedValue({ communities: [] } as ValidCommunitiesResponse),
    isMember: jest.fn().mockResolvedValue(false)
  }
}
