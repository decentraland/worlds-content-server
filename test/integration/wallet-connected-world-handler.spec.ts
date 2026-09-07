import { test } from '../components'
import { IAuthenticatedFetchComponent } from '../components/local-auth-fetch'
import { loadHttpGolden, PulsePeerBody, PulsePeersBody } from '../fixtures/iteration-2/http-goldens'

test('WalletConnectedWorldHandler', function ({ components, stubComponents }) {
  let localFetch: IAuthenticatedFetchComponent

  beforeEach(async () => {
    localFetch = components.localFetch

    const { config } = stubComponents
    config.requireString.mockImplementation(async (name) => (name === 'COMMS_ROOM_PREFIX' ? 'world-test-' : ''))
  })

  describe('when requesting connected world for a wallet', () => {
    it('should return connected world for wallet', async () => {
      const { peersRegistry } = stubComponents
      const wallet = '0xtest'
      const world = 'test-world'

      peersRegistry.getPeerWorld.mockImplementation((id) => (id === wallet ? world : undefined))

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

      peersRegistry.getPeerWorld.mockImplementation((id) => (id === wallet ? world : undefined))

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

      peersRegistry.getPeerWorld.mockImplementation((id) => (id === wallet ? world : undefined))

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

      peersRegistry.getPeerWorld.mockReturnValue(undefined)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        message: `Wallet ${wallet} is not connected to any world`
      })
    })
  })

  // C4-connected-world / C2-peers-single-consume: with PRESENCE_SOURCE=pulse the answer comes from
  // Pulse's single-peer route instead of the LiveKit-fed registry, with the same body.
  describe('when PRESENCE_SOURCE is pulse', () => {
    const PULSE_URL = 'https://pulse.example.com'
    const peerGolden = loadHttpGolden<PulsePeerBody>('peers-single')
    const peerNotFoundGolden = loadHttpGolden<PulsePeerBody>('peers-single-404')
    const peersAllGolden = loadHttpGolden<PulsePeersBody>('peers-all')
    const genesisPeer = peersAllGolden.body.peers.find((peer) => peer.realm === 'main')!

    function servePulse(body: PulsePeerBody, status = 200): void {
      stubComponents.fetch.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }))
    }

    beforeEach(() => {
      const { config } = stubComponents
      config.getString.mockImplementation(async (name: string) => (name === 'PRESENCE_SOURCE' ? 'pulse' : undefined))
      config.requireString.mockImplementation(async (name: string) => (name === 'PULSE_URL' ? PULSE_URL : ''))
    })

    it('should answer 200 with the realm when the peer is in a world', async () => {
      const wallet = peerGolden.body.peer!.address
      servePulse(peerGolden.body)

      const response = await localFetch.fetch(`/wallet/${wallet}/connected-world`, { method: 'GET' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ wallet, world: 'cozyfarm.dcl.eth' })
      expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(`${PULSE_URL}/peers/${wallet}`, expect.anything())
    })

    // The 404s also assert the Pulse call: an empty peers registry answers 404 too, so without it
    // these cases would pass against the pre-Pulse handler.
    it('should answer 404 when the peer is in Genesis City', async () => {
      servePulse({ ok: true, peer: genesisPeer })

      const response = await localFetch.fetch(`/wallet/${genesisPeer.address}/connected-world`, { method: 'GET' })

      expect(response.status).toBe(404)
      expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(
        `${PULSE_URL}/peers/${genesisPeer.address}`,
        expect.anything()
      )
    })

    it('should answer 404 when Pulse does not know the peer', async () => {
      servePulse(peerNotFoundGolden.body, 404)

      const response = await localFetch.fetch('/wallet/0xunknown/connected-world', { method: 'GET' })

      expect(response.status).toBe(404)
      expect(stubComponents.fetch.fetch).toHaveBeenCalledWith(`${PULSE_URL}/peers/0xunknown`, expect.anything())
    })
  })
})
