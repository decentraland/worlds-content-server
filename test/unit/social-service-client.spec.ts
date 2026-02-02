import { createSocialServiceClient, ISocialServiceClient } from '../../src/adapters/social-service-client'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import * as nodeFetch from 'node-fetch'

function mockResponse(options: {
  ok?: boolean
  status?: number
  statusText?: string
  json?: () => Promise<any>
}): nodeFetch.Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: options.json ?? jest.fn().mockResolvedValue({})
  } as unknown as nodeFetch.Response
}

describe('SocialServiceClient', () => {
  let socialServiceClient: ISocialServiceClient
  let mockConfig: jest.Mocked<IConfigComponent>
  let mockFetch: jest.Mocked<IFetchComponent>
  let mockLogs: ILoggerComponent

  beforeEach(() => {
    mockConfig = {
      getString: jest.fn(),
      getNumber: jest.fn(),
      requireString: jest.fn(),
      requireNumber: jest.fn()
    } as unknown as jest.Mocked<IConfigComponent>

    mockFetch = {
      fetch: jest.fn()
    } as unknown as jest.Mocked<IFetchComponent>

    mockLogs = {
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
      })
    } as unknown as ILoggerComponent
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when SOCIAL_SERVICE_URL is not configured', () => {
    beforeEach(async () => {
      mockConfig.getString.mockResolvedValueOnce(undefined)
      socialServiceClient = await createSocialServiceClient({
        config: mockConfig,
        fetch: mockFetch,
        logs: mockLogs
      })
    })

    describe('and getValidCommunities is called', () => {
      it('should return empty communities array', async () => {
        const result = await socialServiceClient.getValidCommunities('0x1234', ['community-1', 'community-2'])
        expect(result).toEqual({ communities: [] })
      })
    })

    describe('and isMember is called', () => {
      it('should return false', async () => {
        const result = await socialServiceClient.isMember('0x1234', 'community-1')
        expect(result).toBe(false)
      })
    })
  })

  describe('when SOCIAL_SERVICE_URL is configured', () => {
    const socialServiceUrl = 'https://social.example.com'

    beforeEach(async () => {
      mockConfig.getString.mockResolvedValueOnce(socialServiceUrl)
      socialServiceClient = await createSocialServiceClient({
        config: mockConfig,
        fetch: mockFetch,
        logs: mockLogs
      })
    })

    describe('when getValidCommunities is called', () => {
      describe('and communityIds is empty', () => {
        it('should return empty communities without making a request', async () => {
          const result = await socialServiceClient.getValidCommunities('0x1234', [])

          expect(result).toEqual({ communities: [] })
          expect(mockFetch.fetch).not.toHaveBeenCalled()
        })
      })

      describe('and the request succeeds', () => {
        let address: string
        let communityIds: string[]

        beforeEach(() => {
          address = '0x1234'
          communityIds = ['community-1', 'community-2']
          mockFetch.fetch.mockResolvedValueOnce(
            mockResponse({
              ok: true,
              json: jest.fn().mockResolvedValueOnce({
                communities: [{ id: 'community-1' }, { id: 'community-2' }]
              })
            })
          )
        })

        it('should call the correct endpoint', async () => {
          await socialServiceClient.getValidCommunities(address, communityIds)

          expect(mockFetch.fetch).toHaveBeenCalledWith(`${socialServiceUrl}/v1/members/0x1234/communities`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ communityIds })
          })
        })

        it('should return the communities from the response', async () => {
          const result = await socialServiceClient.getValidCommunities(address, communityIds)

          expect(result).toEqual({
            communities: [{ id: 'community-1' }, { id: 'community-2' }]
          })
        })

        it('should lowercase the address in the URL', async () => {
          await socialServiceClient.getValidCommunities('0xABCD', communityIds)

          expect(mockFetch.fetch).toHaveBeenCalledWith(
            `${socialServiceUrl}/v1/members/0xabcd/communities`,
            expect.any(Object)
          )
        })
      })

      describe('and the request fails with non-ok status', () => {
        beforeEach(() => {
          mockFetch.fetch.mockResolvedValueOnce(
            mockResponse({
              ok: false,
              status: 500,
              statusText: 'Internal Server Error'
            })
          )
        })

        it('should return empty communities (fail closed)', async () => {
          const result = await socialServiceClient.getValidCommunities('0x1234', ['community-1'])

          expect(result).toEqual({ communities: [] })
        })
      })

      describe('and the request throws an error', () => {
        beforeEach(() => {
          mockFetch.fetch.mockRejectedValueOnce(new Error('Network error'))
        })

        it('should return empty communities (fail closed)', async () => {
          const result = await socialServiceClient.getValidCommunities('0x1234', ['community-1'])

          expect(result).toEqual({ communities: [] })
        })
      })
    })

    describe('when isMember is called', () => {
      describe('and the response is 204 (member)', () => {
        beforeEach(() => {
          mockFetch.fetch.mockResolvedValueOnce(mockResponse({ status: 204 }))
        })

        it('should return true', async () => {
          const result = await socialServiceClient.isMember('0x1234', 'community-1')

          expect(result).toBe(true)
        })

        it('should call the correct endpoint', async () => {
          await socialServiceClient.isMember('0x1234', 'community-1')

          expect(mockFetch.fetch).toHaveBeenCalledWith(
            `${socialServiceUrl}/v1/communities/community-1/members/0x1234`,
            { method: 'GET' }
          )
        })

        it('should lowercase the address in the URL', async () => {
          await socialServiceClient.isMember('0xABCD', 'community-1')

          expect(mockFetch.fetch).toHaveBeenCalledWith(
            `${socialServiceUrl}/v1/communities/community-1/members/0xabcd`,
            expect.any(Object)
          )
        })
      })

      describe('and the response is 404 (not a member)', () => {
        beforeEach(() => {
          mockFetch.fetch.mockResolvedValueOnce(mockResponse({ status: 404 }))
        })

        it('should return false', async () => {
          const result = await socialServiceClient.isMember('0x1234', 'community-1')

          expect(result).toBe(false)
        })
      })

      describe('and the response is an unexpected status code', () => {
        beforeEach(() => {
          mockFetch.fetch.mockResolvedValueOnce(mockResponse({ status: 500 }))
        })

        it('should return false (fail closed)', async () => {
          const result = await socialServiceClient.isMember('0x1234', 'community-1')

          expect(result).toBe(false)
        })
      })

      describe('and the request throws an error', () => {
        beforeEach(() => {
          mockFetch.fetch.mockRejectedValueOnce(new Error('Network error'))
        })

        it('should return false (fail closed)', async () => {
          const result = await socialServiceClient.isMember('0x1234', 'community-1')

          expect(result).toBe(false)
        })
      })
    })
  })
})
