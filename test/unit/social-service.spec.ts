import { createSocialServiceComponent, ISocialServiceComponent } from '../../src/adapters/social-service'
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

describe('SocialServiceComponent', () => {
  const socialServiceUrl = 'https://social.example.com'
  const apiKey = 'test-api-key'

  let mockConfig: jest.Mocked<IConfigComponent>
  let mockFetch: jest.Mocked<IFetchComponent>
  let mockLogs: ILoggerComponent

  beforeEach(() => {
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

  describe('when getMemberCommunities is called', () => {
    describe('and communityIds is empty', () => {
      let socialService: ISocialServiceComponent

      beforeEach(async () => {
        mockConfig = {
          getString: jest.fn().mockResolvedValue(apiKey),
          getNumber: jest.fn(),
          requireString: jest.fn().mockResolvedValue(socialServiceUrl),
          requireNumber: jest.fn()
        } as unknown as jest.Mocked<IConfigComponent>

        socialService = await createSocialServiceComponent({
          config: mockConfig,
          fetch: mockFetch,
          logs: mockLogs
        })
      })

      it('should return empty communities without making a request', async () => {
        const result = await socialService.getMemberCommunities('0x1234', [])

        expect(result).toEqual({ communities: [] })
        expect(mockFetch.fetch).not.toHaveBeenCalled()
      })
    })

    describe('and the API key is not configured', () => {
      let socialService: ISocialServiceComponent

      beforeEach(async () => {
        mockConfig = {
          getString: jest.fn().mockResolvedValue(undefined),
          getNumber: jest.fn(),
          requireString: jest.fn().mockResolvedValue(socialServiceUrl),
          requireNumber: jest.fn()
        } as unknown as jest.Mocked<IConfigComponent>

        socialService = await createSocialServiceComponent({
          config: mockConfig,
          fetch: mockFetch,
          logs: mockLogs
        })
      })

      it('should return empty communities without making a request', async () => {
        const result = await socialService.getMemberCommunities('0x1234', ['community-1'])

        expect(result).toEqual({ communities: [] })
        expect(mockFetch.fetch).not.toHaveBeenCalled()
      })
    })

    describe('and the request succeeds', () => {
      let socialService: ISocialServiceComponent
      let address: string
      let communityIds: string[]

      beforeEach(async () => {
        mockConfig = {
          getString: jest.fn().mockResolvedValue(apiKey),
          getNumber: jest.fn(),
          requireString: jest.fn().mockResolvedValue(socialServiceUrl),
          requireNumber: jest.fn()
        } as unknown as jest.Mocked<IConfigComponent>

        socialService = await createSocialServiceComponent({
          config: mockConfig,
          fetch: mockFetch,
          logs: mockLogs
        })

        address = '0x1234'
        communityIds = ['community-1', 'community-2']
        mockFetch.fetch.mockResolvedValueOnce(
          mockResponse({
            ok: true,
            json: jest.fn().mockResolvedValueOnce({
              data: {
                communities: [{ id: 'community-1' }, { id: 'community-2' }]
              }
            })
          })
        )
      })

      it('should call the correct endpoint with Bearer token', async () => {
        await socialService.getMemberCommunities(address, communityIds)

        expect(mockFetch.fetch).toHaveBeenCalledWith(`${socialServiceUrl}/v1/members/0x1234/communities`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({ communityIds })
        })
      })

      it('should return the communities from the response', async () => {
        const result = await socialService.getMemberCommunities(address, communityIds)

        expect(result).toEqual({
          communities: [{ id: 'community-1' }, { id: 'community-2' }]
        })
      })

      it('should lowercase the address in the URL', async () => {
        await socialService.getMemberCommunities('0xABCD', communityIds)

        expect(mockFetch.fetch).toHaveBeenCalledWith(
          `${socialServiceUrl}/v1/members/0xabcd/communities`,
          expect.any(Object)
        )
      })
    })

    describe('and the request fails with non-ok status', () => {
      let socialService: ISocialServiceComponent

      beforeEach(async () => {
        mockConfig = {
          getString: jest.fn().mockResolvedValue(apiKey),
          getNumber: jest.fn(),
          requireString: jest.fn().mockResolvedValue(socialServiceUrl),
          requireNumber: jest.fn()
        } as unknown as jest.Mocked<IConfigComponent>

        socialService = await createSocialServiceComponent({
          config: mockConfig,
          fetch: mockFetch,
          logs: mockLogs
        })

        mockFetch.fetch.mockResolvedValueOnce(
          mockResponse({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error'
          })
        )
      })

      it('should return empty communities (fail closed)', async () => {
        const result = await socialService.getMemberCommunities('0x1234', ['community-1'])

        expect(result).toEqual({ communities: [] })
      })
    })

    describe('and the request throws an error', () => {
      let socialService: ISocialServiceComponent

      beforeEach(async () => {
        mockConfig = {
          getString: jest.fn().mockResolvedValue(apiKey),
          getNumber: jest.fn(),
          requireString: jest.fn().mockResolvedValue(socialServiceUrl),
          requireNumber: jest.fn()
        } as unknown as jest.Mocked<IConfigComponent>

        socialService = await createSocialServiceComponent({
          config: mockConfig,
          fetch: mockFetch,
          logs: mockLogs
        })

        mockFetch.fetch.mockRejectedValueOnce(new Error('Network error'))
      })

      it('should return empty communities (fail closed)', async () => {
        const result = await socialService.getMemberCommunities('0x1234', ['community-1'])

        expect(result).toEqual({ communities: [] })
      })
    })
  })
})
