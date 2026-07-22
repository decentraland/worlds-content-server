import { createWhitelistComponent } from '../../src/adapters/whitelist'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'
import { Whitelist } from '../../src/types'

describe('whitelist', () => {
  const whitelistUrl = 'http://localhost/whitelist.json'
  const whitelistData: Whitelist = {
    'purchased.dcl.eth': { max_parcels: 44, max_size_in_mb: 160, allow_sdk6: true }
  }

  let config: ReturnType<typeof createMockedConfig>
  let fetch: ReturnType<typeof createMockFetch>
  let logs: ReturnType<typeof createMockLogs>

  beforeEach(() => {
    config = createMockedConfig({ requireString: jest.fn().mockResolvedValue(whitelistUrl) })
    logs = createMockLogs()
  })

  describe('when the source is reachable', () => {
    beforeEach(() => {
      fetch = createMockFetch({
        fetch: jest.fn().mockResolvedValue({ json: () => Promise.resolve(whitelistData) })
      })
    })

    it('should return the fetched whitelist', async () => {
      const whitelist = await createWhitelistComponent({ config, fetch, logs })

      await expect(whitelist.get()).resolves.toEqual(whitelistData)
    })

    it('should serve subsequent calls from cache without re-fetching', async () => {
      const whitelist = await createWhitelistComponent({ config, fetch, logs })

      await whitelist.get()
      await whitelist.get()

      expect(fetch.fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the source is unreachable and nothing was ever cached', () => {
    beforeEach(() => {
      fetch = createMockFetch({
        fetch: jest.fn().mockRejectedValue(new Error('network down'))
      })
    })

    it('should reject so each caller can decide how to degrade', async () => {
      const whitelist = await createWhitelistComponent({ config, fetch, logs })

      await expect(whitelist.get()).rejects.toThrow()
    })
  })
})
