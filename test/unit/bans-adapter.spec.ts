import { createBansComponent, IBansComponent } from '../../src/adapters/bans-adapter'
import { IFetchComponent } from '@dcl/core-commons'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'

describe('BansComponent', () => {
  const commsGatekeeperUrl = 'https://comms-gatekeeper.example.com'
  const authToken = 'test-auth-token'

  let bans: IBansComponent
  let fetch: jest.Mocked<IFetchComponent>

  beforeEach(async () => {
    fetch = createMockFetch()

    bans = await createBansComponent({
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

  describe('when checking if a user is platform-banned', () => {
    const address = '0x1234567890abcdef'
    const deviceId = 'a-device-fingerprint'

    describe('and the user is banned', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should return true', async () => {
        const result = await bans.isPlayerBanned(address)
        expect(result).toBe(true)
      })

      it('should query the device-aware ban-status endpoint with the bearer token', async () => {
        await bans.isPlayerBanned(address)
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/${encodeURIComponent(address)}/ban-status`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`
            }
          }
        )
      })
    })

    describe('and a device id is provided', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should pass the device id as a query parameter', async () => {
        await bans.isPlayerBanned(address, deviceId)
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/${encodeURIComponent(address)}/ban-status?deviceId=${encodeURIComponent(deviceId)}`,
          expect.anything()
        )
      })

      it('should return true when the comms-gatekeeper matches the device', async () => {
        expect(await bans.isPlayerBanned(address, deviceId)).toBe(true)
      })
    })

    describe('and the device id contains query-delimiter characters', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should encode it so it cannot inject extra query parameters', async () => {
        await bans.isPlayerBanned(address, 'a&b=c d')
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/${encodeURIComponent(address)}/ban-status?deviceId=a%26b%3Dc+d`,
          expect.anything()
        )
      })
    })

    describe('and the device id is an empty string', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should omit the query parameter entirely', async () => {
        await bans.isPlayerBanned(address, '')
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/${encodeURIComponent(address)}/ban-status`,
          expect.anything()
        )
      })
    })

    describe('and the address is mixed case', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should lowercase the address in the request path', async () => {
        await bans.isPlayerBanned('0xABCDEF1234567890')
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/0xabcdef1234567890/ban-status`,
          expect.anything()
        )
      })
    })

    describe('and the user is not banned', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should return false', async () => {
        expect(await bans.isPlayerBanned(address)).toBe(false)
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
        const result = await bans.isPlayerBanned(address)
        expect(result).toBe(false)
      })
    })

    describe('and the fetch throws an error', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false (fail open)', async () => {
        const result = await bans.isPlayerBanned(address)
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
        const result = await bans.isPlayerBanned(address)
        expect(result).toBe(false)
      })
    })

    describe('and the first attempt fails transiently before succeeding', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should retry and return the eventual result', async () => {
        expect(await bans.isPlayerBanned(address)).toBe(true)
      })

      it('should have queried the comms-gatekeeper more than once', async () => {
        await bans.isPlayerBanned(address)
        expect(fetch.fetch).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('when checking if a user is banned from a scene', () => {
    const address = '0x1234567890abcdef'
    const worldName = 'my-world.eth'
    const sceneBaseParcel = '0,0'

    describe('and the user is banned', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should return true', async () => {
        const result = await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
        expect(result).toBe(true)
      })

      it('should call the comms-gatekeeper with correct URL and bearer token', async () => {
        await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/worlds/${encodeURIComponent(worldName)}/parcels/${encodeURIComponent(sceneBaseParcel)}/users/${encodeURIComponent(address)}/ban-status`,
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
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should return false', async () => {
        const result = await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
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
        const result = await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
        expect(result).toBe(false)
      })
    })

    describe('and the fetch throws an error', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false (fail open)', async () => {
        const result = await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
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
        const result = await bans.isUserBannedFromScene(address, worldName, sceneBaseParcel)
        expect(result).toBe(false)
      })
    })
  })
})
