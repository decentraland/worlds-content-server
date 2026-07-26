import { createBansComponent, IBansComponent } from '../../src/adapters/bans-adapter'
import { IFetchComponent } from '@dcl/core-commons'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'

describe('BansComponent', () => {
  const commsGatekeeperUrl = 'https://comms-gatekeeper.example.com'
  const authToken = 'test-auth-token'

  let bans: IBansComponent
  let fetch: jest.Mocked<IFetchComponent>
  let logs: jest.Mocked<ILoggerComponent>
  let logger: jest.Mocked<ILoggerComponent.ILogger>

  beforeEach(async () => {
    fetch = createMockFetch()
    logs = createMockLogs()
    logger = logs.getLogger('bans') as jest.Mocked<ILoggerComponent.ILogger>

    bans = await createBansComponent({
      config: createMockedConfig({
        requireString: jest.fn().mockImplementation((key: string) => {
          if (key === 'COMMS_GATEKEEPER_URL') return Promise.resolve(commsGatekeeperUrl)
          if (key === 'COMMS_GATEKEEPER_AUTH_TOKEN') return Promise.resolve(authToken)
          return Promise.resolve('')
        })
      }),
      fetch,
      logs
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

      it('should send the device id in the X-Device-Id header', async () => {
        await bans.isPlayerBanned(address, deviceId)
        expect(fetch.fetch).toHaveBeenCalledWith(
          `${commsGatekeeperUrl}/users/${encodeURIComponent(address)}/ban-status`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authToken}`,
              'X-Device-Id': deviceId
            }
          }
        )
      })

      it('should keep the device id out of the request URL', async () => {
        await bans.isPlayerBanned(address, deviceId)
        expect(fetch.fetch.mock.calls[0][0]).not.toContain(deviceId)
      })

      it('should return true when the comms-gatekeeper matches the device', async () => {
        expect(await bans.isPlayerBanned(address, deviceId)).toBe(true)
      })
    })

    describe('and the device id contains characters that are invalid in a header', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should omit the header rather than forward an injectable value', async () => {
        await bans.isPlayerBanned(address, 'abc\r\nX-Injected: 1')
        expect(fetch.fetch).toHaveBeenCalledWith(expect.any(String), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        })
      })

      it('should warn that the check was downgraded to address-only', async () => {
        await bans.isPlayerBanned(address, 'abc\r\nX-Injected: 1')
        expect(logger.warn).toHaveBeenCalledWith('Ignoring malformed device id, checking the ban by address only', {
          address
        })
      })

      it('should keep the rejected device id out of the logs', async () => {
        await bans.isPlayerBanned(address, 'abc\r\nX-Injected: 1')
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('X-Injected')
      })
    })

    describe('and the device id is well formed', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should not warn about a downgraded check', async () => {
        await bans.isPlayerBanned(address, deviceId)
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('and the device id exceeds the supported length', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should omit the header rather than forward an unbounded value', async () => {
        await bans.isPlayerBanned(address, 'a'.repeat(129))
        expect(fetch.fetch).toHaveBeenCalledWith(expect.any(String), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        })
      })
    })

    describe('and the device id is a plain SHA-256 hex digest', () => {
      let fingerprint: string

      beforeEach(() => {
        fingerprint = 'a'.repeat(64)
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: true })
        } as unknown as Response)
      })

      it('should forward it unchanged', async () => {
        await bans.isPlayerBanned(address, fingerprint)
        expect(fetch.fetch).toHaveBeenCalledWith(expect.any(String), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'X-Device-Id': fingerprint
          }
        })
      })
    })

    describe('and the device id is an empty string', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          ok: true,
          json: jest.fn().mockResolvedValue({ isBanned: false })
        } as unknown as Response)
      })

      it('should omit the header entirely', async () => {
        await bans.isPlayerBanned(address, '')
        expect(fetch.fetch).toHaveBeenCalledWith(expect.any(String), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        })
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
