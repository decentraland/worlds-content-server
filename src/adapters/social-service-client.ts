import { EthAddress } from '@dcl/schemas'
import { IFetchComponent, ILoggerComponent, IConfigComponent } from '@well-known-components/interfaces'

export type ValidCommunitiesResponse = {
  communities: Array<{ id: string }>
}

export interface ISocialServiceClient {
  /**
   * For validation when storing access settings.
   * Returns communities that are valid for the user to add.
   * Makes a POST request to /v1/members/:address/communities
   */
  getValidCommunities(address: EthAddress, communityIds: string[]): Promise<ValidCommunitiesResponse>

  /**
   * For access checking (is user member of this community).
   * Makes a GET request to /v1/communities/:id/members/:address
   * Returns true if 204, false if 404.
   */
  isMember(address: EthAddress, communityId: string): Promise<boolean>
}

export type SocialServiceClientComponents = {
  config: IConfigComponent
  fetch: IFetchComponent
  logs: ILoggerComponent
}

/**
 * Creates a social service client that makes signed fetch requests to the social service.
 * If SOCIAL_SERVICE_URL is not configured, returns a no-op client that always returns empty/false.
 */
export async function createSocialServiceClient(
  components: SocialServiceClientComponents
): Promise<ISocialServiceClient> {
  const { config, fetch, logs } = components
  const logger = logs.getLogger('social-service-client')

  const socialServiceUrl = await config.getString('SOCIAL_SERVICE_URL')

  if (!socialServiceUrl) {
    logger.info('SOCIAL_SERVICE_URL not configured, social service client will be disabled')
    return createNoOpClient()
  }

  logger.info(`Using social service at ${socialServiceUrl}`)

  return {
    async getValidCommunities(address: EthAddress, communityIds: string[]): Promise<ValidCommunitiesResponse> {
      if (communityIds.length === 0) {
        return { communities: [] }
      }

      const url = `${socialServiceUrl}/v1/members/${address.toLowerCase()}/communities`

      try {
        const response = await fetch.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ communityIds })
        })

        if (!response.ok) {
          logger.error(`Failed to get valid communities: ${response.status} ${response.statusText}`, {
            address,
            communityIds: communityIds.join(',')
          })
          // Fail closed: return empty communities on error
          return { communities: [] }
        }

        const data = (await response.json()) as ValidCommunitiesResponse
        return data
      } catch (error) {
        logger.error('Error calling social service getValidCommunities', {
          error: error instanceof Error ? error.message : String(error),
          address,
          communityIds: communityIds.join(',')
        })
        // Fail closed: return empty communities on error
        return { communities: [] }
      }
    },

    async isMember(address: EthAddress, communityId: string): Promise<boolean> {
      const url = `${socialServiceUrl}/v1/communities/${communityId}/members/${address.toLowerCase()}`

      try {
        const response = await fetch.fetch(url, {
          method: 'GET'
        })

        if (response.status === 204) {
          return true
        }

        if (response.status === 404) {
          return false
        }

        // Unexpected status code
        logger.error(`Unexpected response from social service isMember: ${response.status}`, {
          address,
          communityId
        })
        // Fail closed: return false on unexpected response
        return false
      } catch (error) {
        logger.error('Error calling social service isMember', {
          error: error instanceof Error ? error.message : String(error),
          address,
          communityId
        })
        // Fail closed: return false on error
        return false
      }
    }
  }
}

/**
 * Creates a no-op client that returns empty/false for all operations.
 * Used when SOCIAL_SERVICE_URL is not configured.
 */
function createNoOpClient(): ISocialServiceClient {
  return {
    async getValidCommunities(_address: EthAddress, _communityIds: string[]): Promise<ValidCommunitiesResponse> {
      return { communities: [] }
    },

    async isMember(_address: EthAddress, _communityId: string): Promise<boolean> {
      return false
    }
  }
}
