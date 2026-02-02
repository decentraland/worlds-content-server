import { EthAddress } from '@dcl/schemas'
import { AppComponents } from '../types'

export type MemberCommunitiesResponse = {
  communities: Array<{ id: string }>
}

export interface ISocialServiceAdapter {
  /**
   * POST /v1/members/:address/communities
   * Validates which communities from the provided list the user is a member of.
   */
  getMemberCommunities(address: EthAddress, communityIds: string[]): Promise<MemberCommunitiesResponse>

  /**
   * GET /v1/communities/:id/members/:address
   * Checks if the address is a member of the community.
   * Returns true if 204, false if 404.
   */
  isMemberFromCommunity(address: EthAddress, communityId: string): Promise<boolean>
}

export async function createSocialServiceAdapter(
  components: Pick<AppComponents, 'config' | 'fetch' | 'logs'>
): Promise<ISocialServiceAdapter> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('social-service')

  const socialServiceUrl = await config.requireString('SOCIAL_SERVICE_URL')

  logger.info(`Using social service at ${socialServiceUrl}`)

  return {
    async getMemberCommunities(address: EthAddress, communityIds: string[]): Promise<MemberCommunitiesResponse> {
      if (communityIds.length === 0) {
        return { communities: [] }
      }

      try {
        const response = await fetch.fetch(`${socialServiceUrl}/v1/members/${address.toLowerCase()}/communities`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ communityIds })
        })

        if (!response.ok) {
          logger.error(`Failed to get member communities: ${response.status} ${response.statusText}`, {
            address,
            communityIds: JSON.stringify(communityIds)
          })
          return { communities: [] }
        }

        const data = (await response.json()) as MemberCommunitiesResponse
        return data
      } catch (error) {
        logger.error('Error getting member communities', {
          error: error instanceof Error ? error.message : String(error),
          address,
          communityIds: JSON.stringify(communityIds)
        })
        return { communities: [] }
      }
    },

    async isMemberFromCommunity(address: EthAddress, communityId: string): Promise<boolean> {
      try {
        const response = await fetch.fetch(
          `${socialServiceUrl}/v1/communities/${communityId}/members/${address.toLowerCase()}`,
          {
            method: 'GET'
          }
        )

        if (response.status !== 404) {
          logger.error(`Unexpected response when checking if address is member of community: ${response.status}`, {
            address,
            communityId
          })
        }

        return response.status === 204
      } catch (error) {
        logger.error('Error checking if address is member of community', {
          error: error instanceof Error ? error.message : String(error),
          address,
          communityId
        })
        return false
      }
    }
  }
}
