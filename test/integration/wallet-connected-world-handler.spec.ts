import { test } from '../components'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'

test('WalletConnectedWorldHandler', function ({ components, stubComponents }) {
  let localFetch: IAuthenticatedFetchComponent

  beforeEach(async () => {
    localFetch = components.localFetch

    const { config } = stubComponents
    config.requireString.withArgs('COMMS_ROOM_PREFIX').resolves('world-test-')
  })

  describe('when requesting connected world for a wallet', () => {
    it('should return connected world for wallet', async () => {
      const { peersRegistry } = stubComponents
      const wallet = '0xtest'
      const world = 'test-world'

      peersRegistry.getPeerWorld.withArgs(wallet).returns(world)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        wallet,
        world
      })
    })

    it('should return connected world with stripped prefix', async () => {
      const { peersRegistry } = stubComponents
      const wallet = '0xtest'
      const world = 'my-world' // This would be the result after prefix stripping

      peersRegistry.getPeerWorld.withArgs(wallet).returns(world)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        wallet,
        world
      })
    })

    it('should handle wallet with different case', async () => {
      const { peersRegistry } = stubComponents
      const wallet = '0xTEST'
      const world = 'test-world'

      peersRegistry.getPeerWorld.withArgs(wallet).returns(world)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        wallet,
        world
      })
    })
  })

  describe('when wallet is not connected', () => {
    it('should return 404 when wallet is not connected', async () => {
      const response = await localFetch.fetch('/wallet/0xnonexistent/connected-world', { method: 'GET' })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        message: 'Wallet 0xnonexistent is not connected to any world'
      })
    })

    it('should return 404 for empty wallet address', async () => {
      const response = await localFetch.fetch('/wallet//connected-world', { method: 'GET' })
      expect(response.status).toBe(404)
    })
  })

  describe('when peers registry returns undefined', () => {
    it('should return 404 when peers registry returns undefined', async () => {
      const { peersRegistry } = stubComponents
      const wallet = '0xtest'

      peersRegistry.getPeerWorld.withArgs(wallet).returns(undefined)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        message: `Wallet ${wallet} is not connected to any world`
      })
    })
  })
})
