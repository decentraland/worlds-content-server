import { createWorldBanCheckerComponent, IWorldBanCheckerComponent } from '../../src/adapters/world-ban-checker'
import { IFetchComponent } from '@well-known-components/interfaces'
import { Response } from 'node-fetch'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'

describe('WorldBanCheckerComponent', () => {
  const commsGatekeeperUrl = 'https://comms-gatekeeper.example.com'
  const authToken = 'test-auth-token'

  let worldBanChecker: IWorldBanCheckerComponent
  let fetch: jest.Mocked<IFetchComponent>

  beforeEach(async () => {
    fetch = createMockFetch()

    fetch.fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ isBanned: false })
    } as unknown as Response)

    worldBanChecker = await createWorldBanCheckerComponent({
      config: createMockedConfig({
        requireString: jest.fn().mockImplementation((key: string) => {
          if (key === 'COMMS_GATEKEEPER_URL') return Promise.resolve(commsGatekeeperUrl)
          if (key === 'COMMS_GATEKEEPER_AUTH_TOKEN') return Promise.resolve(authToken)
          return Promise.resolve('')
        })
      }),
      fetch,
      logs: createMockLogs()
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking if a user is banned from a world', () => {
    const address = '0x1234567890abcdef'
    const worldName = 'my-world.eth'

    describe('and the user is banned', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should return true', async () => {
        const result = await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(result).toBe(true)
      })

      it('should call the comms-gatekeeper with correct URL and bearer token', async () => {
        await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/worlds/${encodeURIComponent(worldName)}/users/${encodeURIComponent(address)}/ban-status`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          }
        )
      })
    })

    describe('and the user is not banned', () => {
      it('should return false', async () => {
        const result = await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(result).toBe(false)
      })
    })

    describe('and the comms-gatekeeper returns a non-ok response', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: false,
          status: 500,
          json: jest.fn()
        } as unknown as Response)
      })

      it('should return false (fail open)', async () => {
        const result = await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(result).toBe(false)
      })
    })

    describe('and the fetch throws an error', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false (fail open)', async () => {
        const result = await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(result).toBe(false)
      })
    })

    describe('and the response JSON parsing fails', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
        } as unknown as Response)
      })

      it('should return false (fail open)', async () => {
        const result = await worldBanChecker.isUserBannedFromWorld(address, worldName)
        expect(result).toBe(false)
      })
    })
  })
})
