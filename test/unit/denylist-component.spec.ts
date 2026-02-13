import { createDenyListComponent } from '../../src/logic/denylist/component'
import { IDenyListComponent } from '../../src/logic/denylist/types'
import { IFetchComponent } from '@well-known-components/interfaces'
import { Response } from 'node-fetch'
import { createMockedConfig } from '../mocks/config-mock'
import { createMockFetch } from '../mocks/fetch-mock'
import { createMockLogs } from '../mocks/logs-mock'

describe('DenyListComponent', () => {
  const denylistUrl = 'https://config.decentraland.org/denylist.json'

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
        requireString: jest.fn().mockResolvedValue(denylistUrl)
      }),
      fetch,
      logs: createMockLogs()
    })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking if a user is denylisted', () => {
    describe('and the user is in the denylist', () => {
      it('should return true', async () => {
        const result = await denyListComponent.isDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(true)
      })
    })

    describe('and the user is not in the denylist', () => {
      it('should return false', async () => {
        const result = await denyListComponent.isDenylisted('0x2222222222222222222222222222222222222222')
        expect(result).toBe(false)
      })
    })

    describe('and the denylist check is case-insensitive', () => {
      it('should match regardless of case', async () => {
        const result = await denyListComponent.isDenylisted('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')
        expect(result).toBe(true)
      })
    })

    describe('and the denylist response has no users array', () => {
      beforeEach(() => {
        fetch.fetch.mockResolvedValue({
          json: jest.fn().mockResolvedValue({ invalid: 'response' })
        } as unknown as Response)
      })

      it('should return false', async () => {
        const result = await denyListComponent.isDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(false)
      })
    })

    describe('and the fetch fails', () => {
      beforeEach(() => {
        fetch.fetch.mockRejectedValue(new Error('Network error'))
      })

      it('should return false', async () => {
        const result = await denyListComponent.isDenylisted('0xabcdef1234567890abcdef1234567890abcdef12')
        expect(result).toBe(false)
      })
    })
  })
})
