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
    }
  }
}
