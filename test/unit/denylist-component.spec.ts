import { createDenyListComponent } from '../../src/logic/denylist/component'
import { IDenyListComponent } from '../../src/logic/denylist/types'
import { IFetchComponent } from '@dcl/core-commons'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'

const DENYLIST_URL = 'https://config.decentraland.org/denylist.json'
const ASSET_BUNDLE_REGISTRY_URL = 'https://asset-bundle-registry.decentraland.org'

describe('DenyListComponent', () => {
  let denyListComponent: IDenyListComponent
  let fetch: jest.Mocked<IFetchComponent>

  beforeEach(async () => {
    fetch = createMockFetch()

    fetch.fetch.mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        users: [
          { wallet: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' },
          { wallet: '0x1111111111111111111111111111111111111111' }
        ]
      })
    } as unknown as Response)

    denyListComponent = await createDenyListComponent({
      config: createMockedConfig({
        requireString: jest.fn().mockImplementation(async (key: string) => {
          if (key === 'DENYLIST_JSON_URL') return DENYLIST_URL
          if (key === 'ASSET_BUNDLE_REGISTRY_URL') return ASSET_BUNDLE_REGISTRY_URL
          throw new Error(`Unknown config key: ${key}`)
        })
      }),
      fetch,
      logs: createMockLogs()
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('isWalletDenylisted', () => {
    describe('when the wallet is in the denylist', () => {
      it('should return true', async () => {
        const result = await denyListComponent.isWalletDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(true)
      })
    })

    describe('when the wallet is not in the denylist', () => {
      it('should return false', async () => {
        const result = await denyListComponent.isWalletDenylisted('0x2222222222222222222222222222222222222222')
        expect(result).toBe(false)
      })
    })

    describe('when the check is case-insensitive', () => {
      it('should match regardless of case', async () => {
        const result = await denyListComponent.isWalletDenylisted('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')
        expect(result).toBe(true)
      })
    })

    describe('when the denylist response has no users array', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          json: jest.fn().mockResolvedValue({ invalid: 'response' })
        } as unknown as Response)
      })

      it('should return false', async () => {
        const result = await denyListComponent.isWalletDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(false)
      })
    })

    describe('when the fetch fails', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false', async () => {
        const result = await denyListComponent.isWalletDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(false)
      })
    })
  })

  describe('isEntityDenylisted', () => {
    const deniedEntityId = 'bafyreic1111111111111111111111111111111111111111111111111111111'
    const otherEntityId = 'bafyreic2222222222222222222222222222222222222222222222222222222'

    beforeEach(() => {
      fetch.fetch.mockImplementation(async (url: string) => {
        if (String(url).includes('/denylist') && !String(url).endsWith('denylist.json')) {
          return {
            json: jest.fn().mockResolvedValue([{ entity_id: deniedEntityId }])
          } as unknown as Response
        }
        return {
          json: jest.fn().mockResolvedValue({ users: [] })
        } as unknown as Response
      })
    })

    describe('when the entity is in the denylist', () => {
      it('should return true', async () => {
        const result = await denyListComponent.isEntityDenylisted(deniedEntityId)
        expect(result).toBe(true)
      })
    })

    describe('when the entity is not in the denylist', () => {
      it('should return false', async () => {
        const result = await denyListComponent.isEntityDenylisted(otherEntityId)
        expect(result).toBe(false)
      })
    })

    describe('when the check is case-insensitive', () => {
      it('should match regardless of case', async () => {
        const result = await denyListComponent.isEntityDenylisted(deniedEntityId.toUpperCase())
        expect(result).toBe(true)
      })
    })

    describe('when the denylist response is not an array', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          json: jest.fn().mockResolvedValue({ invalid: 'response' })
        } as unknown as Response)
      })

      it('should return false', async () => {
        const result = await denyListComponent.isEntityDenylisted(deniedEntityId)
        expect(result).toBe(false)
      })
    })

    describe('when the fetch fails', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false', async () => {
        const result = await denyListComponent.isEntityDenylisted(deniedEntityId)
        expect(result).toBe(false)
      })
    })
  })
})
