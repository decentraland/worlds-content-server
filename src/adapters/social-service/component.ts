import { EthAddress } from '@dcl/schemas'
import { AppComponents } from '../../types'
import { ISocialServiceComponent, MemberCommunitiesResponse } from './types'

export async function createSocialServiceComponent({
  config,
  fetch,
  logs
}: Pick<AppComponents, 'config' | 'fetch' | 'logs'>): Promise<ISocialServiceComponent> {
  const logger = logs.getLogger('social-service-component')

  const socialServiceUrl = await config.requireString('SOCIAL_SERVICE_URL')
  const apiKey = await config.getString('SOCIAL_SERVICE_API_KEY')

  if (!apiKey) {
    logger.warn('SOCIAL_SERVICE_API_KEY is not configured. Community membership checks will fail.')
  }

  logger.info(`Using social service at ${socialServiceUrl}`)

  async function getMemberCommunities(address: EthAddress, communityIds: string[]): Promise<MemberCommunitiesResponse> {
    if (communityIds.length === 0) {
      return { communities: [] }
    }

    if (!apiKey) {
      logger.error('Cannot check community membership: SOCIAL_SERVICE_API_KEY is not configured')
      return { communities: [] }
    }

    try {
      const response = await fetch.fetch(`${socialServiceUrl}/v1/members/${address.toLowerCase()}/communities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ communityIds })
      })

      if (!response.ok) {
        throw new Error(`Failed to get member communities: ${response.status} ${response.statusText}`)
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

  return {
    getMemberCommunities
  }
}
